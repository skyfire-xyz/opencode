#!/usr/bin/env node

// ---------------------------------------------------------------------------
// Merchant MCP server (HTTP + KYA auth)
//
// This server plays two roles in the demo at once:
//
//   1. A protected MCP resource (port 8787, path /mcp). Unauthenticated
//      requests get a 401 + WWW-Authenticate challenge that advertises the
//      OAuth Authorization Server. Once a valid Bearer access token is
//      presented, it serves the merchant tools (search/cart/checkout/pay)
//      and emits the payments/* signals the gateway settles with a PAY token.
//
//   2. A mock OAuth Authorization Server (port 8788) that mints those Bearer
//      access tokens. It advertises the KYA grant profile and exchanges a
//      Skyfire KYA assertion (jwt-bearer grant, RFC 7523) for an access token,
//      verifying the assertion's signature against Skyfire's JWKS via jose.
//
// Combined flow: opencode connects -> 401 -> silent KYA mint -> access token
// -> connected -> browse/checkout -> gateway mints PAY token -> order confirmed.
// ---------------------------------------------------------------------------

import http from "http"
import crypto from "crypto"
import { createRemoteJWKSet, jwtVerify } from "jose"

// ---------------------------------------------------------------------------
// Network / OAuth configuration
// ---------------------------------------------------------------------------

const mcpPort = Number(process.env.MOCK_MCP_PORT ?? "8787")
const authPort = Number(process.env.MOCK_AUTH_PORT ?? "8788")

const authOrigin = `http://127.0.0.1:${authPort}`
const mcpOrigin = `http://127.0.0.1:${mcpPort}`

const mockSigningSecret = process.env.MOCK_OAUTH_JWT_SECRET ?? "mock-oauth-dev-secret"
const skyfireJwksUrl = process.env.MOCK_SKYFIRE_JWKS_URL ?? "https://app-qa.skyfire.xyz/.well-known/jwks.json"
// Skyfire QA KYA assertions currently use iss=https://app-qa.skyfire.xyz
const mockSkyfireIssuer = process.env.MOCK_SKYFIRE_ISSUER ?? "https://app-qa.skyfire.xyz"
// The audience of the access tokens we issue; must match what /mcp expects.
const resourceAud = process.env.MOCK_MCP_RESOURCE_URI ?? mcpOrigin

// In-memory token store (for introspection/debug) and assertion replay cache.
const issuedTokens = new Map()
const seenAssertionJtis = new Map()
let clientSeq = 0

// ---------------------------------------------------------------------------
// Merchant configuration
// ---------------------------------------------------------------------------

// The merchant's identity on the payment network (Skyfire). The token issuer
// requires this to mint a pay token. Replace with the real Skyfire
// sellerServiceId (discoverable via Skyfire's find-sellers tool).
const SELLER_SERVICE_ID = "662a28ea-fbd7-4bd3-9f05-3d3e6ea14d03"
// Optional search hint the gateway can use to look the seller up via
// find-sellers if SELLER_SERVICE_ID is not a valid network id.
const SELLER_SEARCH_HINT = "Cloud API and GPU compute merchant"
const TAX_RATE = 0.08
const SHIPPING_FLAT = 0.001

// Round to 6 decimal places so sub-cent prices don't collapse to $0.00.
const r6 = (n) => Math.round(n * 1e6) / 1e6
const ACCEPTED_SETTLEMENT_TYPES = ["org.kyapay:kya-pay:coin", "org.kyapay:pay:coin"]

const CATALOG = [
  {
    id: "PROD-001",
    name: "Cloud API Access (1 month)",
    price: 0.001,
    description: "Full REST API access with 10k requests/day.",
  },
  {
    id: "PROD-002",
    name: "Premium Dataset License",
    price: 0.002,
    description: "Licensed access to curated ML training datasets.",
  },
  {
    id: "PROD-003",
    name: "GPU Compute Credits (100 hrs)",
    price: 0.005,
    description: "100 hours of A100 GPU compute time.",
  },
]

const carts = new Map()
let orderSeq = 1000

// ---------------------------------------------------------------------------
// HTTP / JWT helpers
// ---------------------------------------------------------------------------

function json(res, status, body, headers) {
  res.writeHead(status, { "content-type": "application/json", ...(headers ?? {}) })
  res.end(JSON.stringify(body))
}

function text(res, status, body, headers) {
  res.writeHead(status, { "content-type": "text/plain", ...(headers ?? {}) })
  res.end(body)
}

function header(req, key) {
  const value = req.headers[key.toLowerCase()]
  if (typeof value === "string") return value
  return value?.[0]
}

function prefix(value, n) {
  if (value.length <= n) return value
  return value.slice(0, n)
}

function base64url(input) {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buf.toString("base64url")
}

function signJwt(payload, secret) {
  const head = { alg: "HS256", typ: "JWT" }
  const encodedHeader = base64url(JSON.stringify(head))
  const encodedPayload = base64url(JSON.stringify(payload))
  const data = `${encodedHeader}.${encodedPayload}`
  const sig = crypto.createHmac("sha256", secret).update(data).digest()
  return `${data}.${base64url(sig)}`
}

function verifyJwt(token, secret) {
  const [h, p, s] = token.split(".")
  if (!h || !p || !s) return
  const data = `${h}.${p}`
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url")
  if (expected !== s) return
  try {
    return JSON.parse(Buffer.from(p, "base64url").toString("utf8"))
  } catch {
    return
  }
}

function decodeJwtPayload(token) {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"))
  } catch {
    return null
  }
}

const skyfireJwks = createRemoteJWKSet(new URL(skyfireJwksUrl))

async function verifyKyaAssertion(assertion) {
  // Skyfire QA KYA assertions use a non-URL audience (a UUID-like client ID).
  // For the demo, validate signature + iss + exp; claim-shape checks handle the rest.
  const result = await jwtVerify(assertion, skyfireJwks, { issuer: mockSkyfireIssuer })
  const payload = result.payload
  console.log("verifyKyaAssertion: verified", {
    iss: payload.iss,
    aud: payload.aud,
    sub: typeof payload.sub === "string" ? payload.sub : undefined,
    jti: typeof payload.jti === "string" ? payload.jti : undefined,
    exp: typeof payload.exp === "number" ? payload.exp : undefined,
    hasAid: !!payload.aid,
    hasHid: !!payload.hid,
  })
  return payload
}

function checkAndRememberAssertionJti(payload) {
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

// ---------------------------------------------------------------------------
// Merchant tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "search-for-products",
    description:
      "Search the product catalog. Omit query or pass an empty string to list all products. Returns matching products with IDs and prices.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (matched against product name and description). Omit to list all products.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "product-details",
    description: "Get full details for a specific product by its ID.",
    inputSchema: {
      type: "object",
      properties: { product_id: { type: "string", description: "The product ID (e.g. PROD-001)" } },
      required: ["product_id"],
      additionalProperties: false,
    },
  },
  {
    name: "add-to-cart",
    description: "Add a product to the shopping cart. Creates a new cart if none exists.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "The product ID to add" },
        quantity: { type: "number", description: "Quantity to add (default: 1)" },
      },
      required: ["product_id"],
      additionalProperties: false,
    },
  },
  {
    name: "checkout",
    description:
      "Calculate the final order total and return payment requirements. Present the order summary (items, subtotal, tax, shipping, total) to the user and ask for their confirmation BEFORE calling pay.",
    inputSchema: {
      type: "object",
      properties: {
        shipping_address: { type: "string", description: "Full shipping address." },
        billing_address: { type: "string", description: "Billing address (defaults to shipping address)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pay",
    description:
      "Complete payment for the current checkout. Accepts a payment token via _meta as provided by the payment gateway.",
    inputSchema: {
      type: "object",
      properties: {
        shipping_address: { type: "string", description: "Full shipping address." },
        billing_address: { type: "string", description: "Billing address (defaults to shipping address)" },
      },
      additionalProperties: false,
    },
  },
]

function paymentSignal(total, subTotal, taxes) {
  return {
    "payments/settlement/types": ACCEPTED_SETTLEMENT_TYPES,
    "payments/settlement/currency": "USD",
    "payments/amount/total": total,
    "payments/amount/sub-total": subTotal,
    "payments/amount/taxes": taxes,
    "payments/amount/shipping_and_handling": SHIPPING_FLAT,
    "payments/settlement/seller_service_id": SELLER_SERVICE_ID,
    "payments/settlement/seller_search": SELLER_SEARCH_HINT,
  }
}

// Returns a JSON-RPC `result` object: { content, isError?, _meta? }.
// `meta` is the request's params._meta (where the gateway injects the pay token).
function callMerchantTool(name, args, meta) {
  if (name === "search-for-products") {
    const q = (args.query ?? "").toLowerCase()
    const results = q
      ? CATALOG.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
      : CATALOG
    return {
      content: [
        {
          type: "text",
          text: results.length > 0 ? JSON.stringify(results, null, 2) : `No products found matching "${args.query}".`,
        },
      ],
    }
  }

  if (name === "product-details") {
    const product = CATALOG.find((p) => p.id === args.product_id)
    if (!product) return { content: [{ type: "text", text: `Unknown product: ${args.product_id}` }], isError: true }
    return { content: [{ type: "text", text: JSON.stringify(product, null, 2) }] }
  }

  if (name === "add-to-cart") {
    const product = CATALOG.find((p) => p.id === args.product_id)
    if (!product) return { content: [{ type: "text", text: `Unknown product: ${args.product_id}` }], isError: true }

    const quantity = Number.isFinite(args.quantity) && args.quantity >= 1 ? Math.floor(args.quantity) : 1
    const cartId = "cart-default"
    if (!carts.has(cartId)) carts.set(cartId, [])

    const cart = carts.get(cartId)
    const existing = cart.find((item) => item.product_id === args.product_id)
    if (existing) existing.quantity += quantity
    else cart.push({ product_id: args.product_id, name: product.name, price: product.price, quantity })

    return {
      content: [
        {
          type: "text",
          text: `Added ${quantity}x "${product.name}" to cart (${cartId}).\n\nCart contents:\n${JSON.stringify(cart, null, 2)}`,
        },
      ],
    }
  }

  if (name === "checkout") {
    const cart = carts.get("cart-default")
    if (!cart || cart.length === 0) {
      return { content: [{ type: "text", text: "Cart is empty. Add products before checkout." }], isError: true }
    }
    const subTotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0)
    const taxes = r6(subTotal * TAX_RATE)
    const total = r6(subTotal + taxes + SHIPPING_FLAT)
    const items = cart.map((item) => `  - ${item.quantity}x ${item.name} @ $${item.price}`).join("\n")
    // Quote only — deliberately a normal (non-error) result with NO payments/*
    // signal. Emitting the signal here would make the gateway mint a PAY token at
    // checkout, i.e. authorize payment before the user confirms. Settlement is the
    // `pay` tool's job; checkout just previews the order.
    return {
      content: [
        {
          type: "text",
          text: [
            `Order summary:`,
            items,
            `  Subtotal: $${subTotal}`,
            `  Taxes: $${taxes}`,
            `  Shipping: $${SHIPPING_FLAT}`,
            `  Total: $${total}`,
            ``,
            `Confirm these details with the user, then call \`pay\` to complete the purchase.`,
          ].join("\n"),
        },
      ],
    }
  }

  if (name === "pay") {
    const cartId = "cart-default"
    const cart = carts.get(cartId)
    if (!cart || cart.length === 0) {
      return { content: [{ type: "text", text: "Cart is empty. Nothing to pay for." }], isError: true }
    }

    const payToken = meta?.["payments/settlement/token"]
    const settlementType = meta?.["payments/settlement/type"]

    if (!payToken || typeof payToken !== "string") {
      // No token yet — return the payment signal so the gateway can resolve it.
      const subTotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0)
      const taxes = r6(subTotal * TAX_RATE)
      const total = r6(subTotal + taxes + SHIPPING_FLAT)
      return {
        content: [{ type: "text", text: `Payment Required: $${total}` }],
        isError: true,
        _meta: paymentSignal(total, subTotal, taxes),
      }
    }

    const payload = decodeJwtPayload(payToken)
    if (!payload)
      return { content: [{ type: "text", text: "Invalid payment token: could not decode JWT." }], isError: true }
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) {
      return { content: [{ type: "text", text: "Payment token has expired." }], isError: true }
    }

    const subTotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0)
    const taxes = r6(subTotal * TAX_RATE)
    const total = r6(subTotal + taxes + SHIPPING_FLAT)

    carts.delete(cartId)
    const orderId = `ORD-${++orderSeq}`
    const items = cart.map((item) => `  - ${item.quantity}x ${item.name} @ $${item.price}`).join("\n")
    const shippingAddress = args.shipping_address ?? "123 Demo St, San Francisco, CA 94102"

    return {
      content: [
        {
          type: "text",
          text: [
            `Order confirmed!`,
            `  Order ID: ${orderId}`,
            `  Items:`,
            items,
            `  Subtotal: $${subTotal}`,
            `  Taxes: $${taxes}`,
            `  Shipping: $${SHIPPING_FLAT}`,
            `  Total: $${total}`,
            `  Payment: ${settlementType ?? "token"}`,
            `  Shipping to: ${shippingAddress}`,
            `  Status: PAID`,
          ].join("\n"),
        },
      ],
    }
  }

  return { content: [{ type: "text", text: `Unknown tool: ${String(name)}` }], isError: true }
}

// ---------------------------------------------------------------------------
// OAuth Authorization Server (port 8788)
// ---------------------------------------------------------------------------

const authServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", authOrigin)
  console.log("authServer: request", { method: req.method, path: url.pathname })

  if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    return json(res, 200, {
      issuer: authOrigin,
      authorization_endpoint: `${authOrigin}/authorize`,
      token_endpoint: `${authOrigin}/token`,
      registration_endpoint: `${authOrigin}/register`,
      response_types_supported: ["code"],
      authorization_grant_profiles_supported: [
        "urn:ietf:params:oauth:grant-profile:id-jag",
        "urn:ietf:params:oauth:grant-profile:kya",
        "kya",
      ],
    })
  }

  if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
    return json(res, 200, {
      issuer: authOrigin,
      authorization_endpoint: `${authOrigin}/authorize`,
      token_endpoint: `${authOrigin}/token`,
      registration_endpoint: `${authOrigin}/register`,
      response_types_supported: ["code"],
      authorization_grant_profiles_supported: [
        "urn:ietf:params:oauth:grant-profile:id-jag",
        "urn:ietf:params:oauth:grant-profile:kya",
        "kya",
      ],
    })
  }

  if (req.method === "POST" && url.pathname === "/register") {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      try {
        if (raw.trim().length > 0) JSON.parse(raw)
      } catch {
        return json(res, 400, { error: "invalid_client_metadata" })
      }
      clientSeq += 1
      const clientId = `mock_client_${clientSeq}`
      console.log("authServer: register", { clientId })
      return json(res, 201, {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
        redirect_uris: [],
      })
    })
    return
  }

  if (req.method === "POST" && (url.pathname === "/token" || url.pathname === "/oauth/token")) {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const params = new URLSearchParams(raw)
      const grantType = params.get("grant_type")
      const assertion = params.get("assertion")

      console.log("===== OAuth token exchange BEGIN (jwt-bearer) =====", { grantType, hasAssertion: !!assertion })

      if (grantType !== "urn:ietf:params:oauth:grant-type:jwt-bearer") {
        return json(res, 400, { error: "unsupported_grant_type" })
      }
      if (!assertion) {
        return json(res, 400, { error: "invalid_request", error_description: "missing assertion" })
      }

      verifyKyaAssertion(assertion)
        .then((payload) => {
          checkAndRememberAssertionJti(payload)
          const hidObj = payload.hid
          const aidObj = payload.aid
          const hidEmail = typeof hidObj?.email === "string" ? hidObj.email : undefined
          const aidName = typeof aidObj?.name === "string" ? aidObj.name : undefined
          const apd = typeof payload.apd === "string" ? payload.apd : undefined
          const ori = typeof payload.ori === "string" ? payload.ori : undefined

          if (!hidObj || !aidObj) {
            json(res, 400, { error: "invalid_request", error_description: "missing required aid/hid claims" })
            return
          }

          const now = Math.floor(Date.now() / 1000)
          const expiresIn = 3600
          const accessExp = now + expiresIn
          const scope = params.get("scope") ?? "mcp"
          const user = hidEmail ?? JSON.stringify(hidObj)
          const clientMetadata = {}
          if (aidName) clientMetadata.aid = aidName
          if (apd) clientMetadata.apd = apd
          if (ori) clientMetadata.ori = ori

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

          console.log("authServer: token issued", { accessTokenPrefix: prefix(access, 20), scope, exp: accessExp, user })
          console.log("===== OAuth token exchange END (access token issued) =====")

          json(res, 200, { access_token: access, token_type: "Bearer", expires_in: expiresIn, scope })
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e)
          json(res, 401, { error: "invalid_grant", error_description: `invalid assertion: ${msg}` })
        })
    })
    return
  }

  return text(res, 404, "Not found")
})

// ---------------------------------------------------------------------------
// Protected MCP resource (port 8787)
// ---------------------------------------------------------------------------

const mcpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", mcpOrigin)
  console.log("mcpServer: request", {
    method: req.method,
    path: url.pathname,
    authorizationPrefix: prefix(header(req, "authorization") ?? "", 24) || undefined,
  })

  // RFC 9728 — points the MCP SDK at the authorization server. We also advertise
  // our Skyfire seller identity so the KYA flow mints a token for the right
  // seller automatically (no OPENCODE_KYA_SELLER_SERVICE_ID env override needed).
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    return json(res, 200, {
      resource: mcpOrigin,
      authorization_servers: [authOrigin],
      seller_service_id: SELLER_SERVICE_ID,
    })
  }

  if (req.method === "POST" && url.pathname === "/mcp") {
    const auth = req.headers.authorization
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined
    const now = Math.floor(Date.now() / 1000)

    const tokenPayload = token ? verifyJwt(token, mockSigningSecret) : undefined
    const tokenScope = typeof tokenPayload?.scope === "string" ? tokenPayload.scope : undefined
    const tokenExp = typeof tokenPayload?.exp === "number" ? tokenPayload.exp : undefined
    const tokenAud = typeof tokenPayload?.aud === "string" ? tokenPayload.aud : undefined
    const tokenIss = typeof tokenPayload?.iss === "string" ? tokenPayload.iss : undefined
    const tokenSub = typeof tokenPayload?.sub === "string" ? tokenPayload.sub : undefined

    const hasScope = !!tokenScope?.split(/\s+/).includes("mcp")
    const notExpired = typeof tokenExp === "number" ? tokenExp > now : false
    const audOk = tokenAud === resourceAud
    const issOk = tokenIss === authOrigin
    const subOk = typeof tokenSub === "string" && tokenSub.length > 0

    if (!token || !tokenPayload || !notExpired || !audOk || !issOk || !subOk || !hasScope) {
      const challenge = `Bearer realm="mcp", resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource", authorization-uri="${authOrigin}/.well-known/oauth-authorization-server"`
      const reason = !token
        ? "missing_token"
        : !tokenPayload
          ? "invalid_signature"
          : !notExpired
            ? "expired"
            : !audOk
              ? "invalid_audience"
              : !issOk
                ? "invalid_issuer"
                : !subOk
                  ? "missing_subject"
                  : "missing_scope"
      console.log("===== MCP auth flow: 401 challenge sent =====", { reason })
      return text(res, 401, "Unauthorized", { "www-authenticate": challenge })
    }

    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return json(res, 400, { error: "invalid_json" })
      }

      const id = parsed?.id ?? 1
      const method = parsed?.method
      console.log("mcpServer: jsonrpc", { id, method, tool: parsed?.params?.name })

      if (method === "initialize") {
        return json(res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: parsed?.params?.protocolVersion ?? "2024-11-05",
            serverInfo: { name: "merchant-mcp-server", version: "2.0.0" },
            capabilities: { tools: {} },
          },
        })
      }

      // Notifications (e.g. notifications/initialized) carry no id and need no reply.
      if (typeof method === "string" && method.startsWith("notifications/")) {
        res.writeHead(202)
        res.end()
        return
      }

      if (method === "tools/list") {
        return json(res, 200, { jsonrpc: "2.0", id, result: { tools: TOOLS } })
      }

      if (method === "tools/call") {
        const name = parsed?.params?.name
        const args = parsed?.params?.arguments ?? {}
        const meta = parsed?.params?._meta
        const result = callMerchantTool(name, args, meta)
        return json(res, 200, { jsonrpc: "2.0", id, result })
      }

      return json(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } })
    })
    return
  }

  return text(res, 404, "Not found")
})

authServer.listen(authPort, "127.0.0.1", () => {
  console.log(`merchant OAuth Auth Server (KYA) listening: ${authOrigin}`)
  console.log(`  OAuth metadata:  ${authOrigin}/.well-known/oauth-authorization-server`)
  console.log(`  Token endpoint:  ${authOrigin}/token`)
})

mcpServer.listen(mcpPort, "127.0.0.1", () => {
  console.log(`merchant MCP server listening: ${mcpOrigin}`)
  console.log(`  MCP endpoint:    ${mcpOrigin}/mcp`)
  console.log(`  Resource meta:   ${mcpOrigin}/.well-known/oauth-protected-resource`)
})
