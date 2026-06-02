import { test, expect, describe } from "bun:test"
import { Effect } from "effect"
import { McpOAuthProvider, OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH } from "../../src/mcp/oauth-provider"
import type { McpAuth } from "../../src/mcp/auth"

// Stub auth — only a small subset is required by these tests.
const stubAuth = {
  getForUrl: () => Effect.succeed(undefined),
  get: () => Effect.succeed(undefined),
  updateTokens: () => Effect.void,
  updateClientInfo: () => Effect.void,
  updateCodeVerifier: () => Effect.void,
  updateOAuthState: () => Effect.void,
  clearCodeVerifier: () => Effect.void,
  clearOAuthState: () => Effect.void,
  getOAuthState: () => Effect.succeed(undefined),
  remove: () => Effect.void,
  set: () => Effect.void,
  all: () => Effect.succeed({}),
  isTokenExpired: () => Effect.succeed(null),
} as unknown as McpAuth.Interface

const makeProvider = (config: ConstructorParameters<typeof McpOAuthProvider>[2]) =>
  new McpOAuthProvider("test-server", "https://mcp.example.com/mcp", config, { onRedirect: async () => {} }, stubAuth)

describe("McpOAuthProvider.redirectUrl", () => {
  test("defaults to 127.0.0.1:19876/mcp/oauth/callback", () => {
    const provider = makeProvider({})
    expect(provider.redirectUrl).toBe(`http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`)
  })

  test("uses callbackPort when set", () => {
    const provider = makeProvider({ callbackPort: 6620 })
    expect(provider.redirectUrl).toBe(`http://127.0.0.1:6620${OAUTH_CALLBACK_PATH}`)
  })

  test("redirectUri takes precedence over callbackPort", () => {
    const provider = makeProvider({
      callbackPort: 6620,
      redirectUri: "http://127.0.0.1:9999/custom/callback",
    })
    expect(provider.redirectUrl).toBe("http://127.0.0.1:9999/custom/callback")
  })

  test("uses explicit redirectUri when set without callbackPort", () => {
    const provider = makeProvider({ redirectUri: "http://127.0.0.1:8080/oauth/callback" })
    expect(provider.redirectUrl).toBe("http://127.0.0.1:8080/oauth/callback")
  })
})

describe("McpOAuthProvider.clientMetadata", () => {
  test("includes redirect_uris from redirectUrl", () => {
    const provider = makeProvider({ callbackPort: 6620 })
    expect(provider.clientMetadata.redirect_uris).toEqual([`http://127.0.0.1:6620${OAUTH_CALLBACK_PATH}`])
  })

  test("includes scope when set in config", () => {
    const provider = makeProvider({ scope: "openid offline_access" })
    expect(provider.clientMetadata.scope).toBe("openid offline_access")
  })

  test("omits scope when not set in config", () => {
    const provider = makeProvider({})
    expect(provider.clientMetadata.scope).toBeUndefined()
  })

  test("sets token_endpoint_auth_method to client_secret_post when clientSecret provided", () => {
    const provider = makeProvider({ clientSecret: "secret" })
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post")
  })

  test("sets token_endpoint_auth_method to none when no clientSecret", () => {
    const provider = makeProvider({})
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none")
  })
})

describe("McpOAuthProvider KYA", () => {
  test("uses OPENCODE_KYA_CREATE_TOKEN_URL and sends expected payload; parses { token } response", async () => {
    const original = process.env.OPENCODE_KYA_CREATE_TOKEN_URL
    process.env.OPENCODE_KYA_CREATE_TOKEN_URL = "https://api-qa.skyfire.xyz/api/v1/tokens"

    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = []
    const oldFetch = globalThis.fetch
    globalThis.fetch = (async (url: any, init?: any) => {
      const headers = Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      )
      const contentType = headers["content-type"]
      const rawBody = init?.body
      const body =
        typeof rawBody === "string" && contentType === "application/json"
          ? JSON.parse(rawBody)
          : typeof rawBody === "string" && contentType === "application/x-www-form-urlencoded"
            ? Object.fromEntries(new URLSearchParams(rawBody))
            : rawBody
      calls.push({ url: String(url), body, headers })

      // KYA issuer returns { token }
      if (String(url) === "https://api-qa.skyfire.xyz/api/v1/tokens") {
        return new Response(JSON.stringify({ token: "kya.jwt" }), { status: 200 })
      }

      // RAS token endpoint: return a minimal OAuth token response so the hook can complete.
      return new Response(JSON.stringify({ access_token: "access", token_type: "Bearer" }), { status: 200 })
    }) as any

    try {
      const provider = makeProvider({
        kya: {
          apiKey: "test-key",
          tokenType: "kya",
          buyerTag: "buyer",
          tokenAmount: 123,
          sellerServiceId: "svc",
          expiresAt: 1710000000,
        },
      })
      // call the internal codepath through the public hook
      // metadata needs token_endpoint because the hook proceeds to exchange.
      const tokens = await provider.getTokensForMetadata({
        authorization_grant_profiles_supported: ["kya"],
        token_endpoint: "https://ras.example/token",
      })
      expect(tokens?.access_token).toBe("access")

      // First call is to the issuer
      expect(calls[0]?.url).toBe("https://api-qa.skyfire.xyz/api/v1/tokens")
      expect(calls[0]?.headers["content-type"]).toBe("application/json")
      expect(calls[0]?.headers["skyfire-api-key"]).toBe("test-key")
      expect(calls[0]?.body).toEqual({
        type: "kya",
        buyerTag: "buyer",
        tokenAmount: 123,
        sellerServiceId: "svc",
        expiresAt: 1710000000,
      })
    } finally {
      globalThis.fetch = oldFetch
      if (original === undefined) delete process.env.OPENCODE_KYA_CREATE_TOKEN_URL
      else process.env.OPENCODE_KYA_CREATE_TOKEN_URL = original
    }
  })
})
