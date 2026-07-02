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
import { serverAdvertisesKya, KYA_GRANT_PROFILE } from "./kya"
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
  // The full transport URL (may include an MCP path such as `/mcp`). Kept distinct
  // from `serverUrl`, which is normalized to the origin below for OAuth discovery and
  // token-store keying. KYA detection must probe this endpoint, not the origin root,
  // so a server that advertises its `resource_metadata` only via `WWW-Authenticate`
  // on the MCP endpoint is detected correctly.
  private readonly mcpUrl: string

  constructor(
    private mcpName: string,
    private serverUrl: string,
    private config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
    private auth: McpAuth.Interface,
    private allowInteractive = false,
  ) {
    this.mcpUrl = this.serverUrl
    try {
      const parsed = new URL(this.serverUrl)
      this.serverUrl = parsed.origin
    } catch {
      // Leave as-is; the outer connection code already validates URLs.
    }
  }

  private kyaAdvertised?: Promise<boolean>

  private isKyaServer(): Promise<boolean> {
    return (this.kyaAdvertised ??= serverAdvertisesKya(this.mcpUrl))
  }

  /**
   * Whether KYA should handle this connection's auth instead of the SDK's
   * interactive OAuth (Dynamic Client Registration + browser redirect).
   *
   * KYA takes priority when the server advertises the KYA grant profile, so on the
   * auto-connect transport we defer to it (suppress the interactive flow and let the
   * 401 surface to the KYA handlers). Everything else falls back to opencode's default
   * OAuth behavior: servers that don't advertise KYA, and the explicit startAuth()
   * flow (`allowInteractive`), which always runs interactive OAuth regardless of KYA.
   */
  private async shouldDeferToKya(): Promise<boolean> {
    return !this.allowInteractive && (await this.isKyaServer())
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

    if (await this.isKyaServer()) {
      if (!this.allowInteractive) {
        log.warn("[clientInformation] KYA server: suppressing Dynamic Client Registration; routing 401 to KYA", {
          mcpName: this.mcpName,
        })
        throw new UnauthorizedError("DCR suppressed for KYA server; KYA handles this 401")
      }
    }

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
    if (await this.shouldDeferToKya()) {
      log.warn("[redirectToAuthorization] deferring to KYA: suppressing interactive OAuth redirect; routing 401 to KYA", {
        mcpName: this.mcpName,
      })
      throw new UnauthorizedError("interactive OAuth redirect deferred to KYA; KYA handles this 401")
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
      if (value === KYA_GRANT_PROFILE) return ["kya", value]
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
