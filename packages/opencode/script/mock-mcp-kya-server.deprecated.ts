// ---------------------------------------------------------------------------
// DEPRECATED — superseded by the two-process mock in `xyz-clothiers-mock/`
// (mcp-server.js + auth-server.js). That mock is the maintained reference: it
// uses ES256/JWKS assertion validation per Skyfire's verifyToken example, a
// real 401-on-protected-tool flow, and checkout/pay settlement. This single-file
// mock is kept only for older references; prefer xyz-clothiers-mock for new work.
// ---------------------------------------------------------------------------

import http from "http"
import crypto from "crypto"
import { createRemoteJWKSet, jwtVerify } from "jose"

function json(res: http.ServerResponse, status: number, body: unknown, headers?: Record<string, string>) {
  res.writeHead(status, { "content-type": "application/json", ...(headers ?? {}) })
  res.end(JSON.stringify(body))
}

function text(res: http.ServerResponse, status: number, body: string, headers?: Record<string, string>) {
  res.writeHead(status, { "content-type": "text/plain", ...(headers ?? {}) })
  res.end(body)
}

const mcpPort = Number(process.env.MOCK_MCP_PORT ?? "8787")
const authPort = Number(process.env.MOCK_AUTH_PORT ?? "8788")

const authOrigin = `http://127.0.0.1:${authPort}`
const mcpOrigin = `http://127.0.0.1:${mcpPort}`

const mockSigningSecret = process.env.MOCK_OAUTH_JWT_SECRET ?? "mock-oauth-dev-secret"
const skyfireJwksUrl = process.env.MOCK_SKYFIRE_JWKS_URL ?? "https://app-qa.skyfire.xyz/.well-known/jwks.json"
// Skyfire QA KYA assertions currently use iss=https://app-qa.skyfire.xyz
const mockSkyfireIssuer = process.env.MOCK_SKYFIRE_ISSUER ?? "https://app-qa.skyfire.xyz"

type TokenEntry = {
  accessToken: string
  active: boolean
  scope: string
  sub: string
  user: string
  clientId?: string
  clientMetadata?: Record<string, string>
  exp: number
  iat: number
}

// In-memory token store for introspection/debug
const issuedTokens = new Map<string, TokenEntry>()

// In-memory replay cache for incoming KYA assertions (jti -> exp).
// This simulates the "reject duplicate jti" behavior recommended in the spec.
const seenAssertionJtis = new Map<string, number>()

// In-memory OAuth client registrations
let clientSeq = 0

// In-memory authorization codes for the interactive Authorization Code + PKCE flow.
type AuthCodeEntry = {
  codeChallenge?: string
  codeChallengeMethod: string
  redirectUri: string
  scope: string
  clientId?: string
  exp: number
}
const authCodes = new Map<string, AuthCodeEntry>()

// When MOCK_DISABLE_KYA is set, the AS stops advertising the KYA grant profile so
// it behaves like a vanilla OAuth server — useful for testing the interactive
// Authorization Code + PKCE fallback (see OPENCODE_KYA_INTERACTIVE_FALLBACK).
const disableKya = ["1", "true"].includes((process.env.MOCK_DISABLE_KYA ?? "").toLowerCase())

const KYA_GRANT_PROFILES = [
  // Full URNs (per ID-JAG / KYA grant profile draft text in the spec doc)
  "urn:ietf:params:oauth:grant-profile:id-jag",
  "urn:ietf:params:oauth:grant-profile:kya",
  // Compatibility: some clients match on the short token
  "kya",
]

function asMetadata() {
  return {
    issuer: authOrigin,
    authorization_endpoint: `${authOrigin}/authorize`,
    token_endpoint: `${authOrigin}/token`,
    registration_endpoint: `${authOrigin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: [
      "authorization_code",
      ...(disableKya ? [] : ["urn:ietf:params:oauth:grant-type:jwt-bearer"]),
    ],
    code_challenge_methods_supported: ["S256", "plain"],
    authorization_grant_profiles_supported: disableKya ? [] : KYA_GRANT_PROFILES,
  }
}

function header(req: http.IncomingMessage, key: string) {
  const value = req.headers[key.toLowerCase()]
  if (typeof value === "string") return value
  return value?.[0]
}

function prefix(value: string, n: number) {
  if (value.length <= n) return value
  return value.slice(0, n)
}

function base64url(input: Buffer | string) {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buf.toString("base64url")
}

function signJwt(payload: Record<string, unknown>, secret: string) {
  const header = { alg: "HS256", typ: "JWT" }
  const encodedHeader = base64url(JSON.stringify(header))
  const encodedPayload = base64url(JSON.stringify(payload))
  const data = `${encodedHeader}.${encodedPayload}`
  const sig = crypto.createHmac("sha256", secret).update(data).digest()
  return `${data}.${base64url(sig)}`
}

function verifyJwt(token: string, secret: string) {
  const [h, p, s] = token.split(".")
  if (!h || !p || !s) return
  const data = `${h}.${p}`
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url")
  if (expected !== s) return
  try {
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>
    return payload
  } catch {
    return
  }
}

const skyfireJwks = createRemoteJWKSet(new URL(skyfireJwksUrl))

async function verifyKyaAssertion(assertion: string) {
  // Skyfire QA KYA assertions use a non-URL audience (a UUID-like client ID).
  // For the demo, we validate signature + iss + exp, and let claim-shape checks
  // handle the rest.
  const result = await jwtVerify(assertion, skyfireJwks, {
    issuer: mockSkyfireIssuer,
  })

  const payload = result.payload as unknown as Record<string, unknown>
  // eslint-disable-next-line no-console
  console.log("[verifyKyaAssertion] verified", {
    iss: payload.iss,
    aud: payload.aud,
    sub: typeof payload.sub === "string" ? payload.sub : undefined,
    jti: typeof payload.jti === "string" ? payload.jti : undefined,
    iat: typeof payload.iat === "number" ? payload.iat : undefined,
    exp: typeof payload.exp === "number" ? payload.exp : undefined,
    hasAid: !!(payload as any).aid,
    hasHid: !!(payload as any).hid,
  })

  return result.payload
}

function checkAndRememberAssertionJti(payload: Record<string, unknown>) {
  const jti = typeof payload.jti === "string" ? payload.jti : undefined
  const exp = typeof payload.exp === "number" ? payload.exp : undefined
  if (!jti || !exp) return

  const now = Math.floor(Date.now() / 1000)
  for (const [key, value] of seenAssertionJtis.entries()) {
    if (value <= now) seenAssertionJtis.delete(key)
  }

  if (seenAssertionJtis.has(jti)) {
    throw new Error(`assertion replay detected (jti: ${jti})`)
  }

  seenAssertionJtis.set(jti, exp)
}

const authServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", authOrigin)

  // eslint-disable-next-line no-console
  console.log("[authServer] request", { method: req.method, path: url.pathname })

  // --- OAuth / OIDC discovery (Resource Authorization Server metadata) ---
  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration")
  ) {
    return json(res, 200, asMetadata())
  }

  // --- OAuth authorization endpoint (Authorization Code + PKCE) ---
  // The mock auto-approves (no consent UI) and redirects straight back with a code.
  if (req.method === "GET" && url.pathname === "/authorize") {
    const params = url.searchParams
    const responseType = params.get("response_type")
    const redirectUri = params.get("redirect_uri")
    const state = params.get("state") ?? undefined
    const scope = params.get("scope") ?? "mcp"
    const clientId = params.get("client_id") ?? undefined
    const codeChallenge = params.get("code_challenge") ?? undefined
    const codeChallengeMethod = params.get("code_challenge_method") ?? "plain"

    // eslint-disable-next-line no-console
    console.log("===== OAuth interactive flow BEGIN (authorization_code) =====", {
      hasRedirectUri: !!redirectUri,
      hasPkce: !!codeChallenge,
      codeChallengeMethod,
    })

    if (responseType !== "code" || !redirectUri) {
      return json(res, 400, {
        error: "invalid_request",
        error_description: "expected response_type=code and redirect_uri",
      })
    }

    const code = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)
    authCodes.set(code, { codeChallenge, codeChallengeMethod, redirectUri, scope, clientId, exp: now + 300 })

    const location = new URL(redirectUri)
    location.searchParams.set("code", code)
    if (state) location.searchParams.set("state", state)

    // eslint-disable-next-line no-console
    console.log("[authServer] authorize -> redirect", {
      redirectTo: `${location.origin}${location.pathname}`,
      codePrefix: prefix(code, 8),
    })

    res.writeHead(302, { location: location.toString() })
    res.end()
    return
  }

  // --- OAuth dynamic client registration ---
  if (req.method === "POST" && url.pathname === "/register") {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      // The SDK sends JSON client metadata. We don't validate it for the mock.
      try {
        if (raw.trim().length > 0) JSON.parse(raw)
      } catch {
        return json(res, 400, { error: "invalid_client_metadata" })
      }

      clientSeq += 1
      const clientId = `mock_client_${clientSeq}`
      // eslint-disable-next-line no-console
      console.log("[authServer] register", { clientId })
      return json(res, 201, {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
        // Echo back a minimal redirect URI list in case clients inspect it.
        redirect_uris: [],
      })
    })
    return
  }

  // --- OAuth token endpoint (jwt-bearer) ---
  // Accept /token and /oauth/token to mirror common Auth0 deployments.
  if (req.method === "POST" && (url.pathname === "/token" || url.pathname === "/oauth/token")) {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const params = new URLSearchParams(raw)
      const grantType = params.get("grant_type")
      const assertion = params.get("assertion")

      // --- Authorization Code + PKCE grant (interactive fallback) ---
      if (grantType === "authorization_code") {
        const code = params.get("code")
        const redirectUri = params.get("redirect_uri")
        const codeVerifier = params.get("code_verifier")
        // eslint-disable-next-line no-console
        console.log("===== OAuth token exchange BEGIN (authorization_code) =====", {
          hasCode: !!code,
          hasVerifier: !!codeVerifier,
        })

        if (!code) return json(res, 400, { error: "invalid_request", error_description: "missing code" })
        const entry = authCodes.get(code)
        authCodes.delete(code) // single-use
        const now = Math.floor(Date.now() / 1000)
        if (!entry || entry.exp < now) {
          return json(res, 400, { error: "invalid_grant", error_description: "unknown or expired code" })
        }
        if (entry.redirectUri !== redirectUri) {
          return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" })
        }
        if (entry.codeChallenge) {
          const computed =
            entry.codeChallengeMethod === "S256"
              ? crypto
                  .createHash("sha256")
                  .update(codeVerifier ?? "")
                  .digest("base64url")
              : (codeVerifier ?? "")
          if (!codeVerifier || computed !== entry.codeChallenge) {
            return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" })
          }
        }

        const expiresIn = 3600
        const accessExp = now + expiresIn
        const scope = entry.scope
        const user = process.env.MOCK_INTERACTIVE_USER ?? "interactive-user@example.com"
        const resourceAud = process.env.MOCK_MCP_RESOURCE_URI ?? mcpOrigin
        const access = signJwt(
          { iss: authOrigin, aud: resourceAud, sub: user, scope, iat: now, exp: accessExp, jti: crypto.randomUUID() },
          mockSigningSecret,
        )
        issuedTokens.set(access, {
          accessToken: access,
          active: true,
          scope,
          sub: user,
          user,
          clientId: entry.clientId,
          exp: accessExp,
          iat: now,
        })

        // eslint-disable-next-line no-console
        console.log("[authServer] token issued (authorization_code)", {
          accessTokenPrefix: prefix(access, 20),
          scope,
          user,
          resourceAud,
        })
        // eslint-disable-next-line no-console
        console.log("===== OAuth token exchange END (access token issued) =====")
        // eslint-disable-next-line no-console
        console.log("===== OAuth interactive flow END (authorization_code) =====")

        return json(res, 200, { access_token: access, token_type: "Bearer", expires_in: expiresIn, scope })
      }

      // eslint-disable-next-line no-console
      console.log("===== OAuth token exchange BEGIN (jwt-bearer) =====", { grantType, hasAssertion: !!assertion })
      // eslint-disable-next-line no-console
      console.log("[authServer] token(jwt-bearer) request", {
        grantType,
        hasAssertion: !!assertion,
        assertionPrefix: assertion ? prefix(assertion, 18) : undefined,
      })

      if (grantType !== "urn:ietf:params:oauth:grant-type:jwt-bearer") {
        return json(res, 400, { error: "unsupported_grant_type" })
      }
      if (!assertion) {
        return json(res, 400, { error: "invalid_request", error_description: "missing assertion" })
      }

      verifyKyaAssertion(assertion)
        .then((payload) => {
          const assertionPayload = payload as unknown as Record<string, unknown>
          checkAndRememberAssertionJti(assertionPayload)
          // Skyfire QA uses aid/hid as objects (not strings). For the demo we just
          // require they exist and pull a stable identifier from them.
          const hidObj = (assertionPayload as any).hid
          const aidObj = (assertionPayload as any).aid
          const hidEmail = typeof hidObj?.email === "string" ? hidObj.email : undefined
          const aidName = typeof aidObj?.name === "string" ? aidObj.name : undefined
          const apd = typeof (assertionPayload as any).apd === "string" ? (assertionPayload as any).apd : undefined
          const ori = typeof (assertionPayload as any).ori === "string" ? (assertionPayload as any).ori : undefined

          const now = Math.floor(Date.now() / 1000)
          if (!hidObj || !aidObj) {
            json(res, 400, { error: "invalid_request", error_description: "missing required aid/hid claims" })
            return
          }

          const expiresIn = 3600
          const accessExp = now + expiresIn
          const scope = params.get("scope") ?? "mcp"

          // Map KYA claims onto a principal record (demo mapping).
          // - hid -> user
          // - aid + platform metadata -> client metadata
          const user = hidEmail ?? JSON.stringify(hidObj)
          const clientMetadata: Record<string, string> = {}
          if (aidName) clientMetadata.aid = aidName
          if (apd) clientMetadata.apd = apd
          if (ori) clientMetadata.ori = ori

          // Issue access token whose aud equals the protected resource canonical URI.
          const resourceAud = process.env.MOCK_MCP_RESOURCE_URI ?? mcpOrigin

          const access = signJwt(
            {
              iss: authOrigin,
              aud: resourceAud,
              sub: user,
              scope,
              iat: now,
              exp: accessExp,
              jti: crypto.randomUUID(),
              client_metadata: clientMetadata,
            },
            mockSigningSecret,
          )

          issuedTokens.set(access, {
            accessToken: access,
            active: true,
            scope,
            sub: user,
            user,
            clientMetadata,
            exp: accessExp,
            iat: now,
          })

          // eslint-disable-next-line no-console
          console.log("[authServer] token issued", {
            grantType,
            accessTokenPrefix: prefix(access, 20),
            scope,
            exp: accessExp,
            user,
            resourceAud,
          })
          // eslint-disable-next-line no-console
          console.log("===== OAuth token exchange END (access token issued) =====")

          json(res, 200, {
            access_token: access,
            token_type: "Bearer",
            expires_in: expiresIn,
            scope,
          })
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e)
          json(res, 401, { error: "invalid_grant", error_description: `invalid assertion: ${msg}` })
        })
    })
    return
  }

  // --- OAuth token introspection (RFC 7662-ish) ---
  if (req.method === "POST" && url.pathname === "/introspect") {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const params = new URLSearchParams(raw)
      const auth = header(req, "authorization")
      const basic = auth?.startsWith("Basic ") ? auth.slice("Basic ".length) : undefined
      const basicDecoded = basic ? Buffer.from(basic, "base64").toString("utf8") : undefined
      const [basicUser, basicPass] = basicDecoded ? basicDecoded.split(":") : []

      const clientId = params.get("client_id") ?? basicUser
      const clientSecret = params.get("client_secret") ?? basicPass

      // Mirror typical Auth0 behavior: introspection requires client authentication.
      // For the demo, accept any non-empty client_id, and ignore secret validation.
      if (!clientId || clientId.length === 0) {
        return json(res, 401, { error: "invalid_client", error_description: "missing client authentication" })
      }
      if (clientSecret !== undefined && clientSecret.length === 0) {
        return json(res, 401, { error: "invalid_client", error_description: "invalid client secret" })
      }

      const token = params.get("token")
      if (!token) return json(res, 400, { error: "invalid_request", error_description: "missing token" })

      const entry = issuedTokens.get(token)
      const now = Math.floor(Date.now() / 1000)
      if (!entry) return json(res, 200, { active: false })
      if (entry.exp <= now) return json(res, 200, { active: false })
      if (!entry.active) return json(res, 200, { active: false })

      return json(res, 200, {
        active: true,
        iss: authOrigin,
        aud: process.env.MOCK_MCP_RESOURCE_URI ?? mcpOrigin,
        sub: entry.user,
        scope: entry.scope,
        exp: entry.exp,
        iat: entry.iat,
        token_type: "Bearer",
        client_metadata: entry.clientMetadata,
      })
    })
    return
  }

  return text(res, 404, "Not found")
})

const mcpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", mcpOrigin)

  // eslint-disable-next-line no-console
  console.log("[mcpServer] request", {
    method: req.method,
    path: url.pathname,
    authorizationPrefix: prefix(header(req, "authorization") ?? "", 24) || undefined,
  })

  // --- OAuth Protected Resource Metadata (RFC 9728) ---
  // The MCP SDK uses this to discover the authorization server for a protected
  // resource URL. Without it, it falls back to treating the MCP origin itself
  // as the authorization server (and will try POST /register on 8787).
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    // eslint-disable-next-line no-console
    console.log("[mcpServer] oauth-protected-resource", {
      resource: mcpOrigin,
      authorization_servers: [authOrigin],
    })
    return json(res, 200, {
      resource: mcpOrigin,
      authorization_servers: [authOrigin],
    })
  }

  // --- MCP endpoint (fake) ---
  // The MCP client sends JSON-RPC POSTs. We only enforce Bearer auth.
  if (req.method === "POST" && url.pathname === "/mcp") {
    const auth = req.headers.authorization
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined
    const scopeRequired = "mcp"
    const expectedIssuer = authOrigin
    const now = Math.floor(Date.now() / 1000)

    // eslint-disable-next-line no-console
    console.log("[mcpServer] verifyJwt", {
      hasToken: !!token,
      tokenPrefix: token ? prefix(token, 18) : undefined,
    })

    const tokenPayload = token ? verifyJwt(token, mockSigningSecret) : undefined

    // eslint-disable-next-line no-console
    console.log("[mcpServer] verifyJwt result", {
      verified: !!tokenPayload,
      iss: typeof tokenPayload?.iss === "string" ? tokenPayload.iss : undefined,
      aud: typeof tokenPayload?.aud === "string" ? tokenPayload.aud : undefined,
      sub: typeof tokenPayload?.sub === "string" ? prefix(tokenPayload.sub, 24) : undefined,
      exp: typeof tokenPayload?.exp === "number" ? tokenPayload.exp : undefined,
      scope: typeof tokenPayload?.scope === "string" ? tokenPayload.scope : undefined,
    })

    const tokenScope = typeof tokenPayload?.scope === "string" ? tokenPayload.scope : undefined
    const tokenExp = typeof tokenPayload?.exp === "number" ? tokenPayload.exp : undefined
    const tokenAud = typeof tokenPayload?.aud === "string" ? tokenPayload.aud : undefined
    const tokenIss = typeof tokenPayload?.iss === "string" ? tokenPayload.iss : undefined
    const tokenSub = typeof tokenPayload?.sub === "string" ? tokenPayload.sub : undefined

    const hasScope = !!tokenScope?.split(/\s+/).includes(scopeRequired)
    const notExpired = typeof tokenExp === "number" ? tokenExp > now : false
    const audOk = tokenAud === (process.env.MOCK_MCP_RESOURCE_URI ?? mcpOrigin)
    const issOk = tokenIss === expectedIssuer
    const subOk = typeof tokenSub === "string" && tokenSub.length > 0

    if (!token || !tokenPayload || !notExpired || !audOk || !issOk || !subOk || !hasScope) {
      const challenge = `Bearer realm=\"mcp\", authorization-uri=\"${authOrigin}/.well-known/oauth-authorization-server\"`

      const reason = (() => {
        switch (true) {
          case !token:
            return "missing_token" as const
          case !tokenPayload:
            return "invalid_signature" as const
          case !notExpired:
            return "expired" as const
          case !audOk:
            return "invalid_audience" as const
          case !issOk:
            return "invalid_issuer" as const
          case !subOk:
            return "missing_subject" as const
          case !hasScope:
            return "missing_scope" as const
          default:
            return "unknown" as const
        }
      })()

      // eslint-disable-next-line no-console
      console.log("===== MCP auth flow BEGIN (401 challenge sent) =====", { reason })
      // eslint-disable-next-line no-console
      console.log("[mcpServer] unauthorized", {
        hasAuthHeader: !!auth,
        tokenPrefix: token ? prefix(token, 18) : undefined,
        issuedTokenCount: issuedTokens.size,
        wwwAuthenticate: challenge,
        reason,
      })

      // Signal OAuth discovery via standard metadata locations.
      return text(res, 401, "Unauthorized", {
        "www-authenticate": challenge,
      })
    }

    // eslint-disable-next-line no-console
    console.log("[mcpServer] authorized", {
      iss: tokenIss,
      aud: tokenAud,
      sub: tokenSub ? prefix(tokenSub, 24) : undefined,
      scope: tokenScope,
      exp: tokenExp,
    })
    // eslint-disable-next-line no-console
    console.log("===== MCP auth flow END (request authorized with Bearer token) =====")

    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      // Minimal JSON-RPC initialize response. This is enough for many clients
      // to consider the server connected.
      let parsed: any
      try {
        parsed = JSON.parse(raw)
      } catch {
        return json(res, 400, { error: "invalid_json" })
      }

      const id = parsed?.id ?? 1
      const method = parsed?.method

      // eslint-disable-next-line no-console
      console.log("[mcpServer] jsonrpc", {
        id,
        method,
        tool: typeof parsed?.params?.name === "string" ? parsed.params.name : undefined,
      })

      if (method === "initialize") {
        // eslint-disable-next-line no-console
        console.log("[mcpServer] initialize")
        return json(res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: parsed?.params?.protocolVersion ?? "2024-11-05",
            serverInfo: { name: "mock-mcp-kya", version: "0.0.1" },
            capabilities: {},
          },
        })
      }

      if (method === "tools/list") {
        // eslint-disable-next-line no-console
        console.log("[mcpServer] tools/list")
        return json(res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "echo",
                description: "Echo back the provided text (mock tool)",
                inputSchema: {
                  type: "object",
                  properties: {
                    text: { type: "string", description: "Text to echo" },
                  },
                  required: ["text"],
                  additionalProperties: false,
                },
              },
              {
                name: "add",
                description: "Add two numbers together (mock tool)",
                inputSchema: {
                  type: "object",
                  properties: {
                    a: { type: "number", description: "First number" },
                    b: { type: "number", description: "Second number" },
                  },
                  required: ["a", "b"],
                  additionalProperties: false,
                },
              },
            ],
          },
        })
      }

      if (method === "tools/call") {
        const name = parsed?.params?.name
        const args = parsed?.params?.arguments ?? {}

        // eslint-disable-next-line no-console
        console.log("[mcpServer] tools/call", { name })

        if (name === "echo") {
          const textValue = typeof args.text === "string" ? args.text : ""
          return json(res, 200, {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: textValue }],
              isError: false,
            },
          })
        }

        if (name === "add") {
          const a = typeof args.a === "number" ? args.a : Number(args.a)
          const b = typeof args.b === "number" ? args.b : Number(args.b)
          const sum = (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0)
          return json(res, 200, {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: String(sum) }],
              isError: false,
            },
          })
        }

        return json(res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Unknown tool: ${String(name)}` }],
            isError: true,
          },
        })
      }

      return json(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      })
    })
    return
  }

  return text(res, 404, "Not found")
})

authServer.listen(authPort, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`mock OAuth Auth Server (KYA) listening: ${authOrigin}`)
  // eslint-disable-next-line no-console
  console.log(`  Mode:            ${disableKya ? "interactive (KYA disabled)" : "KYA jwt-bearer"}`)
  // eslint-disable-next-line no-console
  console.log(`  OAuth metadata:  ${authOrigin}/.well-known/oauth-authorization-server`)
  // eslint-disable-next-line no-console
  console.log(`  Authorize:       ${authOrigin}/authorize`)
  // eslint-disable-next-line no-console
  console.log(`  Token endpoint:  ${authOrigin}/token`)
})

mcpServer.listen(mcpPort, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`mock MCP server listening: ${mcpOrigin}`)
  // eslint-disable-next-line no-console
  console.log(`  MCP endpoint:    ${mcpOrigin}/mcp`)
})
