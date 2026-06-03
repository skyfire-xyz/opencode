import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { Effect } from "effect"
import { McpAuth } from "./auth"
import * as Log from "@opencode-ai/core/util/log"
import { Flag } from "@opencode-ai/core/flag/flag"

const log = Log.create({ service: "mcp.oauth" })

const OAUTH_CALLBACK_PORT = 19876
const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"

export const AcceptedTokens = {
  kya: "kya",
  pay: "pay",
  "kya-pay": "kya-pay",
} as const

export type AcceptedTokenType = (typeof AcceptedTokens)[keyof typeof AcceptedTokens]

export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
  callbackPort?: number
  redirectUri?: string

  /**
   * KYA (Know Your Agent) support.
   *
   * When the Resource Authorization Server advertises
   * `authorization_grant_profiles_supported: ["kya"]` in either
   * `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration`,
   * OpenCode can use a KYA assertion to obtain an OAuth access token.
   */
  kya?: {
    /** API key sent as the `skyfire-api-key` request header. */
    apiKey?: string

    /** JSON payload `type` field. */
    tokenType?: AcceptedTokenType

    buyerTag?: string
    tokenAmount?: number
    sellerServiceId?: string
    /** unix seconds */
    expiresAt?: number
  }
}

export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>
}

export class McpOAuthProvider implements OAuthClientProvider {
  constructor(
    private mcpName: string,
    private serverUrl: string,
    private config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
    private auth: McpAuth.Interface,
  ) {
    // The MCP SDK treats the auth provider's "server URL" as the *origin* where
    // OAuth discovery endpoints live (/.well-known/*). Our MCP transport URLs
    // often include the MCP RPC path (e.g. http://host:port/mcp). Normalize
    // that to the origin so discovery doesn't 404 on /mcp/.well-known/*.
    try {
      const parsed = new URL(this.serverUrl)
      this.serverUrl = parsed.origin
    } catch {
      // Leave as-is; the outer connection code already validates URLs.
    }
  }

  /**
   * The MCP SDK's StreamableHTTP transport will try OAuth discovery against the
   * MCP origin by requesting `/.well-known/oauth-authorization-server`.
   *
   * Our KYA mock (and some real deployments) host OAuth metadata on a separate
   * auth origin and advertise it via `WWW-Authenticate: ... authorization-uri="..."`
   * on 401 responses from the MCP endpoint.
   *
   * To avoid a confusing "Invalid OAuth error response" when the MCP origin
   * correctly returns plain-text 404 for `/.well-known/*`, we proactively trigger
   * a 401 against the MCP endpoint and let the SDK parse the advertised metadata.
   */
  private async ensureDiscoveryViaWwwAuthenticate(): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2_000)

    try {
      const url = new URL(this.serverUrl)
      url.pathname = "/mcp"
      url.search = ""
      url.hash = ""

      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
        signal: controller.signal,
      })

      if (res.status === 401) {
        // Throwing the SDK's UnauthorizedError is enough for it to parse
        // `WWW-Authenticate` and continue the OAuth discovery flow.
        throw new UnauthorizedError("MCP server requires authentication")
      }
    } catch {
      // This is a best-effort preflight; ignore failures and let the SDK do its normal flow.
    } finally {
      clearTimeout(timeout)
    }
  }

  get redirectUrl(): string {
    // KYA uses a non-interactive jwt-bearer grant; if we provide a redirect URL
    // the MCP SDK will force an interactive authorization_code flow.
    if (this.config.kya) return ""

    if (this.config.redirectUri) {
      return this.config.redirectUri
    }
    const port = this.config.callbackPort ?? OAUTH_CALLBACK_PORT
    return `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "OpenCode",
      client_uri: "https://opencode.ai",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    }
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    await this.ensureDiscoveryViaWwwAuthenticate()

    // Check config first (pre-registered client)
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }
    }

    // Check stored client info (from dynamic registration)
    // Use getForUrl to validate credentials are for the current server URL
    const entry = await Effect.runPromise(this.auth.getForUrl(this.mcpName, this.serverUrl))
    if (entry?.clientInfo) {
      // Check if client secret has expired
      if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
        log.info("client secret expired, need to re-register", { mcpName: this.mcpName })
        return undefined
      }
      return {
        client_id: entry.clientInfo.clientId,
        client_secret: entry.clientInfo.clientSecret,
      }
    }

    // No client info or URL changed - will trigger dynamic registration
    return undefined
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await Effect.runPromise(
      this.auth.updateClientInfo(
        this.mcpName,
        {
          clientId: info.client_id,
          clientSecret: info.client_secret,
          clientIdIssuedAt: info.client_id_issued_at,
          clientSecretExpiresAt: info.client_secret_expires_at,
        },
        this.serverUrl,
      ),
    )
    log.info("saved dynamically registered client", {
      mcpName: this.mcpName,
      clientId: info.client_id,
    })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // Use getForUrl to validate tokens are for the current server URL
    const entry = await Effect.runPromise(this.auth.getForUrl(this.mcpName, this.serverUrl))
    if (!entry?.tokens) return undefined

    return {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
      refresh_token: entry.tokens.refreshToken,
      expires_in: entry.tokens.expiresAt
        ? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
        : undefined,
      scope: entry.tokens.scope,
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await Effect.runPromise(
      this.auth.updateTokens(
        this.mcpName,
        {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
          scope: tokens.scope,
        },
        this.serverUrl,
      ),
    )
    log.info("saved oauth tokens", { mcpName: this.mcpName })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    log.info("redirecting to authorization", { mcpName: this.mcpName, url: authorizationUrl.toString() })
    await this.callbacks.onRedirect(authorizationUrl)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await Effect.runPromise(this.auth.updateCodeVerifier(this.mcpName, codeVerifier))
  }

  async codeVerifier(): Promise<string> {
    const entry = await Effect.runPromise(this.auth.get(this.mcpName))
    if (!entry?.codeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.mcpName}`)
    }
    return entry.codeVerifier
  }

  async saveState(state: string): Promise<void> {
    await Effect.runPromise(this.auth.updateOAuthState(this.mcpName, state))
  }

  async state(): Promise<string> {
    const entry = await Effect.runPromise(this.auth.get(this.mcpName))
    if (entry?.oauthState) {
      return entry.oauthState
    }

    // Generate a new state if none exists — the SDK calls state() as a
    // generator, not just a reader, so we need to produce a value even when
    // startAuth() hasn't pre-saved one (e.g. during automatic auth on first
    // connect).
    const newState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    await Effect.runPromise(this.auth.updateOAuthState(this.mcpName, newState))
    return newState
  }

  async invalidateCredentials(type: "all" | "client" | "tokens"): Promise<void> {
    log.info("invalidating credentials", { mcpName: this.mcpName, type })
    const entry = await Effect.runPromise(this.auth.get(this.mcpName))
    if (!entry) {
      return
    }

    switch (type) {
      case "all":
        await Effect.runPromise(this.auth.remove(this.mcpName))
        break
      case "client":
        delete entry.clientInfo
        await Effect.runPromise(this.auth.set(this.mcpName, entry))
        break
      case "tokens":
        delete entry.tokens
        await Effect.runPromise(this.auth.set(this.mcpName, entry))
        break
    }
  }

  /**
   * Optional hook for MCP SDKs that support custom grant profiles.
   *
   * If the connected Resource Authorization Server supports the KYA profile,
   * we can obtain an access token without an interactive authorization_code flow.
   */
  async getTokensForMetadata(metadata: unknown): Promise<OAuthTokens | undefined> {
    const profiles = authorizationGrantProfilesSupported(metadata)
    const supportsKya = profiles.includes("kya")
    log.info("getTokensForMetadata: evaluating metadata for KYA", {
      mcpName: this.mcpName,
      supportsKya,
      hasKyaConfig: !!this.config.kya,
      profiles: profiles.slice(0, 8),
    })

    if (!supportsKya) return undefined
    if (!this.config.kya) return undefined

    const assertion = await requestKyaAssertion(this.config.kya)
    const tokenEndpoint = tokenEndpointFromMetadata(metadata)
    if (!tokenEndpoint) {
      throw new Error(
        `Resource Authorization Server metadata for ${this.mcpName} advertises KYA but has no token_endpoint`,
      )
    }

    const exchanged = await exchangeKyaForAccessToken({
      tokenEndpoint,
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      assertion,
      scope: this.config.scope,
    })

    await this.saveTokens(exchanged)
    return exchanged
  }

  /**
   * Provide a non-interactive token request for servers that advertise the KYA
   * grant profile.
   *
   * The MCP SDK prefers prepareTokenRequest() over opening an interactive
   * /authorize flow.
   */
  async prepareTokenRequest(scope?: string): Promise<URLSearchParams | undefined> {
    if (!this.config.kya) return undefined

    // For KYA, failing to mint/exchange the assertion should be surfaced
    // directly; "fall back" produces a confusing SDK error because KYA disables
    // the interactive redirect flow.
    log.info("prepareTokenRequest: preparing jwt-bearer token request", {
      mcpName: this.mcpName,
      hasScope: !!(scope ?? this.config.scope),
    })

    const assertion = await requestKyaAssertion(this.config.kya)
    const params = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    })
    const effectiveScope = scope ?? this.config.scope
    if (effectiveScope) params.set("scope", effectiveScope)
    return params
  }
}

export { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH }

/**
 * Parse a redirect URI to extract port and path for the callback server.
 * Returns defaults if the URI can't be parsed.
 */
export function parseRedirectUri(redirectUri?: string): { port: number; path: string } {
  if (!redirectUri) {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }

  try {
    const url = new URL(redirectUri)
    const port = url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80
    const path = url.pathname || OAUTH_CALLBACK_PATH
    return { port, path }
  } catch {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }
}

function authorizationGrantProfilesSupported(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return []
  const obj = metadata as Record<string, unknown>
  const arr = obj["authorization_grant_profiles_supported"]
  if (!Array.isArray(arr)) return []
  return arr
    .filter((v): v is string => typeof v === "string")
    .flatMap((value) => {
      if (value === "urn:ietf:params:oauth:grant-profile:kya") return ["kya", value]
      if (value === "urn:ietf:params:oauth:grant-profile:id-jag") return ["id-jag", value]
      return [value]
    })
}

function tokenEndpointFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const obj = metadata as Record<string, unknown>
  const tokenEndpoint = obj["token_endpoint"]
  if (typeof tokenEndpoint === "string") return tokenEndpoint
  return undefined
}

async function requestKyaAssertion(config: NonNullable<McpOAuthConfig["kya"]>): Promise<string> {
  const issuerUrl = Flag.OPENCODE_KYA_CREATE_TOKEN_URL
  if (!issuerUrl) {
    throw new Error("Missing KYA issuer URL (set experimental.kya.create_token_url or OPENCODE_KYA_CREATE_TOKEN_URL)")
  }

  const apiKey = config.apiKey ?? Flag.OPENCODE_SKYFIRE_API_KEY
  const sellerServiceId = config.sellerServiceId

  if (!sellerServiceId) {
    throw new Error("Missing kya.sellerServiceId (must be a valid UUID)")
  }

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  if (!uuid.test(sellerServiceId)) {
    throw new Error(`Invalid kya.sellerServiceId (must be a UUID): ${sellerServiceId}`)
  }

  const payload = {
    type: config.tokenType,
    buyerTag: config.buyerTag,
    expiresAt: config.expiresAt ?? Math.floor((Date.now() + 5 * 60 * 1000) / 1000),
    sellerServiceId,
  }

  log.info("requestKyaAssertion: requesting kya assertion", {
    issuer: issuerUrl,
    tokenType: config.tokenType,
    buyerTag: config.buyerTag,
    sellerServiceId,
    hasApiKey: !!apiKey,
    expiresAt: payload.expiresAt,
  })

  const res = await fetch(issuerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { "skyfire-api-key": apiKey } : {}),
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    throw new Error(`KYA issuer request failed (${res.status}): ${await res.text()}`)
  }
  const data = (await res.json()) as unknown
  log.info("requestKyaAssertion: received response from kya issuer", { hasToken: !!(data as any)?.token })
  if (!data || typeof data !== "object") {
    throw new Error("KYA issuer returned non-object JSON")
  }
  const token = (data as Record<string, unknown>)["token"]
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("KYA issuer response missing `token` string")
  }

  log.info("requestKyaAssertion: received kya assertion", {
    issuer: issuerUrl,
    tokenPrefix: token.slice(0, 16),
  })
  return token
}

async function exchangeKyaForAccessToken(input: {
  tokenEndpoint: string
  clientId?: string
  clientSecret?: string
  assertion: string
  scope?: string
}): Promise<OAuthTokens> {
  log.info("exchangeKyaForAccessToken: exchanging kya assertion for oauth token", {
    tokenEndpoint: input.tokenEndpoint,
    hasScope: !!input.scope,
    assertionPrefix: input.assertion.slice(0, 16),
  })

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: input.assertion,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.clientId ? { client_id: input.clientId } : {}),
    ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
  })

  const res = await fetch(input.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!res.ok) {
    log.warn("exchangeKyaForAccessToken: oauth token exchange failed", {
      tokenEndpoint: input.tokenEndpoint,
      status: res.status,
    })
    throw new Error(`OAuth token exchange failed (${res.status}): ${await res.text()}`)
  }
  const json = (await res.json()) as Record<string, unknown>
  const accessToken = json["access_token"]
  const refreshToken = json["refresh_token"]
  const expiresIn = json["expires_in"]
  const scope = json["scope"]
  const tokenType = json["token_type"]
  if (typeof accessToken !== "string") throw new Error("OAuth token exchange missing access_token")
  if (tokenType && tokenType !== "Bearer") throw new Error(`Unexpected token_type: ${String(tokenType)}`)

  log.info("exchangeKyaForAccessToken: oauth token exchange succeeded", {
    tokenEndpoint: input.tokenEndpoint,
    accessTokenPrefix: accessToken.slice(0, 12),
  })

  return {
    access_token: accessToken,
    token_type: "Bearer",
    refresh_token: typeof refreshToken === "string" ? refreshToken : undefined,
    expires_in: typeof expiresIn === "number" ? expiresIn : undefined,
    scope: typeof scope === "string" ? scope : undefined,
  }
}
