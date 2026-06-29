#!/usr/bin/env node

// ---------------------------------------------------------------------------
// Mock OAuth Authorization Server for the XYZ-Clothiers mock MCP server.
//
// Modeled on the OAuth AS in ../merchant-mcp/merchant.js. It:
//
//   1. Advertises OAuth/OIDC discovery metadata (RFC 8414) and the KYA grant
//      profile.
//   2. Exchanges a REAL Skyfire KYA token (the assertion) for a Bearer
//      access_token via the jwt-bearer grant (RFC 7523).
//
// KYA tokens are NOT minted here — they come from Skyfire (e.g. the
// `create-kya-token` tool on mcp-qa.skyfire.xyz). This server verifies the
// assertion's signature against Skyfire's live JWKS via jose, exactly like
// merchant.js, then mints an HS256 access_token.
//
// The access_token is signed with ACCESS_TOKEN_SECRET. The mock MCP server
// (mcp-server.js) verifies access tokens with the same secret, so a token from here
// unlocks the protected merchant tools.
//
// Flow: Skyfire mints kya_token -> POST /oauth/token (jwt-bearer) ->
//       access_token -> Authorization: Bearer <access_token> on /mcp ->
//       protected tools.
// ---------------------------------------------------------------------------

import http from "http"
import crypto from "crypto"
import { createRemoteJWKSet, jwtVerify } from "jose"

// ---------------------------------------------------------------------------
// Environment variables — every process.env read lives here, in one place.
// ---------------------------------------------------------------------------

// Static fallback table: Skyfire issuer URL per environment (used by the
// MOCK_SKYFIRE_ISSUER fallback just below).
const SKYFIRE_ISSUER_BY_ENV = {
  production: "https://app.skyfire.xyz",
  sandbox: "https://app-sandbox.skyfire.xyz",
  qa: "https://app-qa.skyfire.xyz",
}

// Network.
const port = Number(process.env.AUTH_PORT ?? "8788")
const host = process.env.HOST ?? "127.0.0.1"
const publicBaseUrl = (process.env.AUTH_PUBLIC_BASE_URL ?? `http://${host}:${port}`).replace(/\/$/, "")

// Issued access tokens: signed with ACCESS_TOKEN_SECRET (mcp-server.js verifies
// with the same), with aud = MOCK_MCP_RESOURCE_URI (must match what /mcp expects).
const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET ?? "mock-access-dev-secret"
const resourceAud = process.env.MOCK_MCP_RESOURCE_URI ?? "http://127.0.0.1:8799/mcp"

// KYA assertion validation, modeled on Skyfire's official verifyToken example:
// https://github.com/skyfire-xyz/kyapay/blob/main/code-examples/verifyToken/typescript/src/verifyKyaTokenToExternalSeller.ts
// We verify the signature against Skyfire's JWKS (pinned to ES256 via MOCK_SKYFIRE_ALG),
// the issuer, the header `typ`, the common claims (env, iat, jti, exp), the seller
// domain (sdm), and the KYA identity (hid.email). `sdm` varies per target
// (e.g. "auth101.dev", "mcp-server.com"); set MOCK_SKYFIRE_EXPECTED_SDM to enforce a
// specific seller, or "" to skip. Defaults target the Skyfire QA environment.
const expectedEnv = process.env.MOCK_SKYFIRE_ENV ?? "qa"
const skyfireIssuer = process.env.MOCK_SKYFIRE_ISSUER ?? SKYFIRE_ISSUER_BY_ENV[expectedEnv] ?? SKYFIRE_ISSUER_BY_ENV.qa
const skyfireJwksUrl = process.env.MOCK_SKYFIRE_JWKS_URL ?? `${skyfireIssuer}/.well-known/jwks.json`
const skyfireAlg = process.env.MOCK_SKYFIRE_ALG ?? "ES256"
const expectedTyp = process.env.MOCK_SKYFIRE_EXPECTED_TYP ?? "kya+jwt"
const expectedSdm = process.env.MOCK_SKYFIRE_EXPECTED_SDM ?? "mcp-server.com"

// Dynamic Client Registration (DCR) is only used by the interactive OAuth fallback,
// not the KYA jwt-bearer path. Disabled by default so the AS doesn't advertise or
// honor /register; set ENABLE_DCR=1 to turn it back on.
const enableDcr = ["1", "true"].includes((process.env.ENABLE_DCR ?? "").toLowerCase())

// ---------------------------------------------------------------------------
// Derived configuration (no env reads below this point).
// ---------------------------------------------------------------------------

const authOrigin = publicBaseUrl
const skyfireJwks = createRemoteJWKSet(new URL(skyfireJwksUrl))

// Claim-shape helpers ported from the Skyfire verifyToken example (the example
// uses the `validator` package; we inline equivalent checks to stay dependency-free).
function isEpochSeconds(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1_000_000_000 && value <= 9_999_999_999
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isUuid = (value) => typeof value === "string" && UUID_RE.test(value)
const isEmail = (value) => typeof value === "string" && EMAIL_RE.test(value)

// In-memory token store (debug/introspection) and assertion replay cache.
const issuedTokens = new Map()
const seenAssertionJtis = new Map()

// Compact logger: prints "[functionName] message ...". Extra args are appended.
// A leading blank line separates consecutive entries so the log is easy to scan.
function log(fn, message, ...rest) {
  console.log(`\n\n[${fn}] ${message}`, ...rest)
}

// Labeled divider. The SERVER_NAME tag makes this server's log blocks easy to
// tell apart from the MCP server's (they interleave under `npm run dev`), and a
// divider brackets the start of each request.
const SERVER_NAME = "AUTH SERVER"
function divider(title) {
  console.log(`\n========================= ${SERVER_NAME} · ${title} =========================`)
}

// Truncate long tokens for log output so we never dump a full JWT.
function preview(value, n = 24) {
  if (typeof value !== "string") return value
  return value.length <= n ? value : `${value.slice(0, n)}...(${value.length} chars)`
}

// ---------------------------------------------------------------------------
// HTTP / JWT helpers (HS256 for access tokens, mirroring merchant.js)
// ---------------------------------------------------------------------------

// Preview token-like / long string fields so a logged response never dumps a full JWT.
function sanitizeForLog(body) {
  if (!body || typeof body !== "object") return body
  const out = {}
  for (const [key, value] of Object.entries(body)) {
    const isSecret = key === "access_token" || key === "assertion" || key === "kya_token"
    out[key] = typeof value === "string" && (isSecret || value.length > 60) ? preview(value) : value
  }
  return out
}

function json(res, status, body, headers) {
  log("response", `──── RESPONSE ${status} (application/json) ────`, sanitizeForLog(body))
  res.writeHead(status, { "content-type": "application/json", ...(headers ?? {}) })
  res.end(JSON.stringify(body))
}

function text(res, status, body, headers) {
  log("response", `──── RESPONSE ${status} (text/plain) ────`, { body: preview(body, 80) })
  res.writeHead(status, { "content-type": "text/plain", ...(headers ?? {}) })
  res.end(body)
}

function base64url(input) {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buf.toString("base64url")
}

function signJwt(payload, secret) {
  const head = { alg: "HS256", typ: "JWT" }
  const data = `${base64url(JSON.stringify(head))}.${base64url(JSON.stringify(payload))}`
  const sig = crypto.createHmac("sha256", secret).update(data).digest()
  const token = `${data}.${base64url(sig)}`
  log("signJwt", "signed HS256 token", { sub: payload.sub, exp: payload.exp, jti: payload.jti })
  return token
}

function verifyJwt(token, secret) {
  const [h, p, s] = token.split(".")
  if (!h || !p || !s) {
    log("verifyJwt", "malformed token (expected 3 parts)")
    return
  }
  const expected = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")
  if (expected !== s) {
    log("verifyJwt", "signature mismatch")
    return
  }
  try {
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"))
    log("verifyJwt", "signature OK", { sub: payload.sub, exp: payload.exp })
    return payload
  } catch {
    log("verifyJwt", "payload is not valid JSON")
    return
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => resolve(raw))
  })
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "*",
}

// ---------------------------------------------------------------------------
// KYA assertion handling (real Skyfire tokens, verified via JWKS)
// ---------------------------------------------------------------------------

// Verify a real Skyfire KYA assertion, following the steps in Skyfire's official
// verifyToken example (verifyKyaTokenToExternalSeller.ts):
//   1. jwtVerify — signature against Skyfire's JWKS, pinned algorithm + issuer
//      (jose also enforces exp/nbf internally).
//   2. header `typ` matches the expected KYA token type.
//   3. common payload claims: env, iat (epoch seconds, past), jti (UUID),
//      exp (epoch seconds, future).
//   4. sdm matches the expected seller domain.
//   5. KYA identity: hid.email is a valid email.
// Throws on any failure; the caller maps that to an invalid_grant 401. The `typ`
// and `sdm` checks are skipped when their expected values are empty.
async function verifyKyaAssertion(assertion) {
  log("verifyKyaAssertion", "verifying Skyfire KYA assertion (per Skyfire verifyToken example)", {
    assertion: preview(assertion),
    jwks: skyfireJwksUrl,
    expectedIssuer: skyfireIssuer,
    algorithm: skyfireAlg,
    expectedEnv,
    expectedTyp: expectedTyp || "(skipped)",
    expectedSdm: expectedSdm || "(skipped)",
  })

  // 1. Signature + algorithm + issuer.
  const { payload, protectedHeader: header } = await jwtVerify(assertion, skyfireJwks, {
    algorithms: [skyfireAlg],
    issuer: skyfireIssuer,
  })

  // 2. Header typ (e.g. "kya+jwt").
  if (expectedTyp && header.typ !== expectedTyp) {
    throw new Error(`invalid typ: expected "${expectedTyp}", got "${header.typ}"`)
  }

  // 3. Common payload claims.
  if (payload.env !== expectedEnv) {
    throw new Error(`invalid env: expected "${expectedEnv}", got "${payload.env}"`)
  }
  const now = Math.floor(Date.now() / 1000)
  if (!isEpochSeconds(payload.iat) || payload.iat > now) {
    throw new Error("invalid iat: must be a 10-digit epoch-seconds value in the past")
  }
  if (!isUuid(payload.jti)) {
    throw new Error("invalid jti: must be a valid UUID")
  }
  if (!isEpochSeconds(payload.exp) || payload.exp < now) {
    throw new Error("invalid exp: must be a 10-digit epoch-seconds value in the future")
  }

  // 4. sdm matches the expected seller domain.
  if (expectedSdm && payload.sdm !== expectedSdm) {
    throw new Error(`invalid sdm: expected "${expectedSdm}", got "${payload.sdm}"`)
  }

  // 5. KYA identity claims.
  const email = payload?.hid?.email
  if (!isEmail(email)) {
    throw new Error("invalid email: hid.email must be a valid email address")
  }

  log("verifyKyaAssertion", "assertion verified (signature + header + claims OK)", {
    iss: payload.iss,
    aud: payload.aud,
    sub: typeof payload.sub === "string" ? payload.sub : undefined,
    jti: typeof payload.jti === "string" ? payload.jti : undefined,
    exp: typeof payload.exp === "number" ? payload.exp : undefined,
    env: payload.env,
    sdm: payload.sdm,
    typ: header.typ,
    email,
    hasAid: !!payload.aid,
    hasHid: !!payload.hid,
  })
  return payload
}

function checkAndRememberAssertionJti(payload) {
  const jti = typeof payload.jti === "string" ? payload.jti : undefined
  const exp = typeof payload.exp === "number" ? payload.exp : undefined
  if (!jti || !exp) {
    log("checkAndRememberAssertionJti", "assertion has no jti/exp, skipping replay check")
    return
  }
  const now = Math.floor(Date.now() / 1000)
  let evicted = 0
  for (const [key, value] of seenAssertionJtis.entries()) {
    if (value <= now) {
      seenAssertionJtis.delete(key)
      evicted++
    }
  }
  if (evicted > 0) log("checkAndRememberAssertionJti", `evicted ${evicted} expired jti(s) from replay cache`)
  if (seenAssertionJtis.has(jti)) {
    log("checkAndRememberAssertionJti", "REPLAY DETECTED", { jti })
    throw new Error(`assertion replay detected (jti: ${jti})`)
  }
  seenAssertionJtis.set(jti, exp)
  log("checkAndRememberAssertionJti", "jti recorded", { jti, cacheSize: seenAssertionJtis.size })
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", authOrigin)
  divider(`${req.method} ${url.pathname}`)
  log("handleRequest", "incoming request", { method: req.method, path: url.pathname })

  if (req.method === "OPTIONS") {
    log("handleRequest", "CORS preflight, replying 204")
    res.writeHead(204, CORS)
    return res.end()
  }

  if (url.pathname === "/") {
    log("handleRequest", "health check, replying ok")
    return text(res, 200, "ok")
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration")
  ) {
    log("handleDiscovery", "serving AS metadata (RFC 8414)", { path: url.pathname })
    return json(
      res,
      200,
      {
        issuer: authOrigin,
        authorization_endpoint: `${authOrigin}/authorize`,
        token_endpoint: `${authOrigin}/oauth/token`,
        // Only advertise DCR when it's enabled (§ENABLE_DCR); omitted by default.
        ...(enableDcr ? { registration_endpoint: `${authOrigin}/register` } : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
        authorization_grant_profiles_supported: [
          "urn:ietf:params:oauth:grant-profile:id-jag",
          "urn:ietf:params:oauth:grant-profile:kya",
          "kya",
        ],
      },
      CORS,
    )
  }

  // Dynamic client registration (DCR) — accept anything, mint a client id.
  if (req.method === "POST" && url.pathname === "/register") {
    if (!enableDcr) {
      log("handleRegister", "════ /register CALLED but DCR is DISABLED (set ENABLE_DCR=1 to enable) ════")
      return json(
        res,
        404,
        { error: "registration_not_supported", error_description: "Dynamic client registration is disabled." },
        CORS,
      )
    }
    log("handleRegister", "dynamic client registration request")
    const raw = await readBody(req)
    if (raw.trim().length > 0) {
      try {
        JSON.parse(raw)
      } catch {
        log("handleRegister", "rejected: body is not valid JSON")
        return json(res, 400, { error: "invalid_client_metadata" }, CORS)
      }
    }
    const clientId = `mock_client_${crypto.randomUUID()}`
    log("handleRegister", "registered client", { clientId })
    return json(
      res,
      201,
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
        redirect_uris: [],
      },
      CORS,
    )
  }

  // Token exchange: real Skyfire kya_token (assertion) -> access_token via jwt-bearer.
  if (req.method === "POST" && (url.pathname === "/oauth/token" || url.pathname === "/token")) {
    const raw = await readBody(req)
    const params = new URLSearchParams(raw)
    const grantType = params.get("grant_type")
    // Accept the assertion under either the RFC 7523 `assertion` param or `kya_token`.
    const assertion = params.get("assertion") ?? params.get("kya_token")

    log("handleTokenExchange", "════════ KYA → ACCESS TOKEN EXCHANGE BEGIN (jwt-bearer) ════════")
    log("handleTokenExchange", "──── token exchange REQUEST ────", {
      grantType,
      scope: params.get("scope") ?? undefined,
      resource: params.get("resource") ?? undefined,
      params: [...params.keys()],
      hasAssertion: !!assertion,
      kyaToken: assertion ? preview(assertion) : undefined,
    })

    if (grantType !== "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      log("handleTokenExchange", "rejected: unsupported grant_type", { grantType })
      return json(res, 400, { error: "unsupported_grant_type" }, CORS)
    }
    if (!assertion) {
      log("handleTokenExchange", "rejected: missing assertion")
      return json(res, 400, { error: "invalid_request", error_description: "missing assertion" }, CORS)
    }

    // The KYA token is minted upstream by Skyfire (create-kya-token); here it
    // arrives as the exchange `assertion`. Log the full value for debugging.
    log("handleTokenExchange", "──── KYA token received (full) ────", { kyaToken: assertion })

    let payload
    try {
      payload = await verifyKyaAssertion(assertion)
      checkAndRememberAssertionJti(payload)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log("handleTokenExchange", "rejected: assertion verification failed", { reason: msg })
      return json(res, 401, { error: "invalid_grant", error_description: `invalid assertion: ${msg}` }, CORS)
    }

    if (!payload.aid || !payload.hid) {
      log("handleTokenExchange", "rejected: missing aid/hid claims", { hasAid: !!payload.aid, hasHid: !!payload.hid })
      return json(res, 400, { error: "invalid_request", error_description: "missing required aid/hid claims" }, CORS)
    }

    const now = Math.floor(Date.now() / 1000)
    const expiresIn = 3600
    const scope = params.get("scope") ?? "openid profile email mcp"
    const hidEmail = typeof payload.hid?.email === "string" ? payload.hid.email : undefined
    const user = hidEmail ?? JSON.stringify(payload.hid)
    const clientMetadata = {}
    if (typeof payload.aid?.name === "string") clientMetadata.aid = payload.aid.name
    if (typeof payload.apd === "string") clientMetadata.apd = payload.apd
    if (typeof payload.ori === "string") clientMetadata.ori = payload.ori

    log("handleTokenExchange", "minting access token", { user, scope, aud: resourceAud, clientMetadata })
    const access = signJwt(
      {
        iss: authOrigin,
        aud: resourceAud,
        sub: user,
        scope,
        iat: now,
        exp: now + expiresIn,
        jti: crypto.randomUUID(),
        client_metadata: clientMetadata,
      },
      accessTokenSecret,
    )

    issuedTokens.set(access, { active: true, scope, sub: user, exp: now + expiresIn, iat: now })
    log("handleTokenExchange", "──── access token CREATED (full) ────", {
      accessToken: access,
      sub: user,
      scope,
      iat: now,
      exp: now + expiresIn,
    })
    log("handleTokenExchange", "════════ KYA → ACCESS TOKEN EXCHANGE END (access token issued) ════════", {
      user,
      scope,
      expiresIn,
      accessToken: preview(access),
      issuedCount: issuedTokens.size,
    })

    return json(res, 200, { access_token: access, token_type: "Bearer", expires_in: expiresIn, scope }, CORS)
  }

  // Token introspection (debug aid).
  if (req.method === "POST" && url.pathname === "/introspect") {
    log("handleIntrospect", "introspection request")
    const raw = await readBody(req)
    const token = new URLSearchParams(raw).get("token")
    const payload = token ? verifyJwt(token, accessTokenSecret) : undefined
    if (!payload) {
      log("handleIntrospect", "token inactive (missing or invalid)")
      return json(res, 200, { active: false }, CORS)
    }
    const now = Math.floor(Date.now() / 1000)
    const active = payload.exp > now
    log("handleIntrospect", "introspection result", { active, sub: payload.sub, exp: payload.exp })
    return json(res, 200, { active, ...payload }, CORS)
  }

  log("handleRequest", "no route matched, replying 404", { path: url.pathname })
  return text(res, 404, "Not found")
})

server.listen(port, host, () => {
  log("listen", `auth server listening on ${host}:${port}`)
  log("listen", `discovery:      ${authOrigin}/.well-known/oauth-authorization-server`)
  log("listen", `token exchange: ${authOrigin}/oauth/token (jwt-bearer: Skyfire kya_token -> access_token)`)
  log("listen", `resource aud:   ${resourceAud}`)
  log("listen", `skyfire JWKS:   ${skyfireJwksUrl}`)
  log("listen", `kya validation: alg=${skyfireAlg} iss=${skyfireIssuer} env=${expectedEnv}`)
  log("listen", `                typ=${expectedTyp || "(skipped)"} sdm=${expectedSdm || "(skipped)"}`)
})
