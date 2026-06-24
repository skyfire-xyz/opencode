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
import { serverAdvertisesKya } from "./kya"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "mcp.oauth" })

const OAUTH_CALLBACK_PORT = 19876
const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"

export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
  callbackPort?: number
  redirectUri?: string
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
    // When false (the default, used by the auto-connect / live transport), the SDK's
    // interactive OAuth path is suppressed *only for servers that advertise the KYA
    // grant profile*: no Dynamic Client Registration and no browser redirect — the
    // 401 surfaces as UnauthorizedError so the KYA flow takes over. Non-KYA servers
    // still get the full standard interactive OAuth (DCR + browser) so this provider
    // keeps working for ordinary OAuth MCP servers. The explicit startAuth() flow
    // passes `true` to force interactive behavior regardless of KYA advertisement.
    private allowInteractive = false,
  ) {
    // The MCP SDK treats the auth provider's "server URL" as the *origin* where
    // OAuth discovery endpoints live (/.well-known/*). Our MCP transport URLs
    // often include the MCP RPC path (e.g. http://host:port/mcp). Normalize
    // that to the origin so discovery doesn't 404 on /mcp/.well-known/* and so
    // tokens stored by the out-of-band KYA flow (keyed by origin) are matched
    // by getForUrl() here.
    try {
      const parsed = new URL(this.serverUrl)
      this.serverUrl = parsed.origin
    } catch {
      // Leave as-is; the outer connection code already validates URLs.
    }
  }

  // Memoized: whether the target server advertises the KYA grant profile. Used to
  // decide whether to suppress interactive OAuth (KYA servers) or let it proceed
  // (ordinary OAuth servers). Cached so the SDK's repeated provider calls during a
  // single auth attempt don't re-run discovery.
  private kyaAdvertised?: Promise<boolean>

  /**
   * Whether the SDK's interactive OAuth path (Dynamic Client Registration +
   * browser redirect) should be suppressed for this server. True only when this
   * provider is non-interactive (auto-connect transport) AND the server advertises
   * the KYA grant profile — in which case KYA, not interactive OAuth, is the auth path.
   */
  private async shouldSuppressInteractive(): Promise<boolean> {
    if (this.allowInteractive) return false
    this.kyaAdvertised ??= serverAdvertisesKya(this.serverUrl)
    return this.kyaAdvertised
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
    const stored = entry?.clientInfo
    const storedExpired = !!stored?.clientSecretExpiresAt && stored.clientSecretExpiresAt < Date.now() / 1000
    if (stored && !storedExpired) {
      return {
        client_id: stored.clientId,
        client_secret: stored.clientSecret,
      }
    }
    if (storedExpired) {
      log.info("[clientInformation] client secret expired, need to re-register", { mcpName: this.mcpName })
    }

    // No usable client. Returning `undefined` makes the SDK perform Dynamic Client
    // Registration (POST <AS>/register). For KYA servers on the auto-connect transport
    // we must NOT do that — KYA is the auth path — so abort and let the 401 surface as
    // an UnauthorizedError to our handlers (connect-time KYA / the tool-call hook).
    // Non-KYA servers fall through to standard DCR.
    if (await this.shouldSuppressInteractive()) {
      log.warn("[clientInformation] KYA server: suppressing Dynamic Client Registration; routing 401 to KYA", {
        mcpName: this.mcpName,
      })
      throw new UnauthorizedError("DCR suppressed for KYA server; KYA handles this 401")
    }
    // Interactive flow: no client info or URL changed — trigger dynamic registration.
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
    log.info("[saveClientInformation] saved dynamically registered client", {
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
    log.info("[saveTokens] saved oauth tokens", { mcpName: this.mcpName })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (await this.shouldSuppressInteractive()) {
      // KYA server on the auto-connect transport: never send the user to a browser.
      // Abort so the 401 surfaces as UnauthorizedError and KYA handles it. Non-KYA
      // servers proceed with the normal browser redirect below.
      log.warn("[redirectToAuthorization] KYA server: suppressing interactive OAuth redirect; routing 401 to KYA", {
        mcpName: this.mcpName,
      })
      throw new UnauthorizedError("interactive OAuth redirect suppressed for KYA server; KYA handles this 401")
    }
    log.info("[redirectToAuthorization] redirecting to authorization", {
      mcpName: this.mcpName,
      url: authorizationUrl.toString(),
    })
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
    log.info("[invalidateCredentials] invalidating credentials", { mcpName: this.mcpName, type })
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
   * SDK grant-profile hooks (getTokensForMetadata / prepareTokenRequest).
   *
   * These intentionally return `undefined`. The KYA jwt-bearer exchange is NOT
   * driven through this provider — it runs out-of-band in `trySilentKya`
   * (see mcp/index.ts), which performs RFC 9728/8414 discovery, mints the KYA
   * token from the issuer, exchanges it for an access token, and stores it via
   * `saveTokens()` before the transport is retried. Returning `undefined` here
   * keeps that flow authoritative and lets the SDK fall back to the interactive
   * authorization_code path when KYA is unavailable.
   */
  async getTokensForMetadata(metadata: unknown): Promise<OAuthTokens | undefined> {
    const profiles = authorizationGrantProfilesSupported(metadata)
    log.info("[getTokensForMetadata] deferring KYA to out-of-band trySilentKya", {
      mcpName: this.mcpName,
      profiles: profiles.slice(0, 8),
    })
    return undefined
  }

  async prepareTokenRequest(_scope?: string): Promise<URLSearchParams | undefined> {
    return undefined
  }
}

export { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH }

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
