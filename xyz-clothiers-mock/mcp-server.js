#!/usr/bin/env node

// ---------------------------------------------------------------------------
// Mock "XYZ-Clothiers" MCP server.
//
// Reproduces the observed XYZ-Clothiers tool surface (an Auth0/Okta swag store)
// with a toggleable auth gate that mimics Skyfire KYA protection:
//
//   - OPEN tools (no auth): catalog browsing — getCategories, getFeaturedProducts,
//     getProduct, searchProducts, and getCart (returns an empty "sign in" state
//     when unauthenticated).
//   - PROTECTED tools (auth required): cart mutations, checkout, and orders —
//     addToCart, removeFromCart, clearCart, checkout, getOrder, getPreviousOrders.
//
// Auth model: this is a Streamable-HTTP MCP server on /mcp. When REQUIRE_AUTH is
// on (default), a request that calls a protected tool without a valid Bearer
// token gets a tool result mirroring the real server's message, while a bare MCP
// connection without a token still gets a 401 + WWW-Authenticate challenge so a
// KYA-aware client can discover the (mock) OAuth AS. Set REQUIRE_AUTH=0 to run
// fully open for local testing.
// ---------------------------------------------------------------------------

import http from "http"
import crypto from "crypto"

// ---------------------------------------------------------------------------
// Environment variables — every process.env read lives here, in one place.
// ---------------------------------------------------------------------------

// Network.
const port = Number(process.env.PORT ?? "8799")
const host = process.env.HOST ?? "127.0.0.1"
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? `http://${host}:${port}`).replace(/\/$/, "")

// Auth gate. REQUIRE_AUTH=0 runs fully open; ACCEPT_ANY_TOKEN=1 accepts any
// non-empty Bearer without verifying. Access tokens are HS256 JWTs from the mock
// auth server, verified with the shared ACCESS_TOKEN_SECRET; their iss must match
// AUTH_SERVER and their aud must be this resource.
const requireAuth = process.env.REQUIRE_AUTH !== "0"
const acceptAnyToken = process.env.ACCEPT_ANY_TOKEN === "1"
const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET ?? "mock-access-dev-secret"
const authServer = (process.env.AUTH_SERVER ?? "http://127.0.0.1:8788").replace(/\/$/, "")
const RESOURCE_NAME = process.env.RESOURCE_NAME ?? "Auth101 Swag MCP Server"

// Payment settlement (used by `checkout` / `pay`), mirroring ../merchant-mcp/merchant.js.
// SETTLEMENT_SCALE multiplies the amount sent to the issuer's create-pay-token so QA
// mints stay sub-cent (catalog/summaries still show real dollars); 0.00001 turns a
// ~$100 order into ~$0.001. Set 1 to settle the real dollar amount.
const TAX_RATE = Number(process.env.TAX_RATE ?? "0.08")
const SHIPPING_FLAT = Number(process.env.SHIPPING_FLAT ?? "5")
const SETTLEMENT_CURRENCY = process.env.SETTLEMENT_CURRENCY ?? "USD"
const SETTLEMENT_SCALE = Number(process.env.SETTLEMENT_SCALE ?? "0.00001")
// The merchant's identity on the Skyfire payment network (defaults to the
// merchant-mcp demo seller). The gateway needs this to mint a pay token.
const SELLER_SERVICE_ID = process.env.SELLER_SERVICE_ID ?? "662a28ea-fbd7-4bd3-9f05-3d3e6ea14d03"
const SELLER_SEARCH_HINT = process.env.SELLER_SEARCH_HINT ?? "Auth0 and Okta swag merchant"
// CSV of issuer origins allowed to settle COIN payments (closed-loop).
const ACCEPTED_ISSUERS = (process.env.ACCEPTED_ISSUERS ?? "https://mcp-qa.skyfire.xyz")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
// Skyfire REST API used by `pay` to actually CHARGE the pay token (mirrors
// merchant.js). The seller API key authenticates the charge — override via env.
const SKYFIRE_API_BASE_URL = (process.env.SKYFIRE_API_BASE_URL ?? "https://api-qa.skyfire.xyz").replace(/\/$/, "")
const SKYFIRE_SELLER_API_KEY = process.env.SKYFIRE_SELLER_API_KEY ?? "8987b55a-44f7-4f64-ab8e-1ff76663b03c"

// ---------------------------------------------------------------------------
// Derived configuration (no env reads below this point).
// ---------------------------------------------------------------------------

// Resource-metadata fields, copied from the real XYZ-Clothiers server
// (https://store.auth101.dev/.well-known/oauth-protected-resource).
const resourceUri = `${publicBaseUrl}/mcp`
const SCOPES_SUPPORTED = ["openid", "profile", "email"]
const ACCEPTED_SETTLEMENT_TYPES = ["org.kyapay:kya-pay:coin", "org.kyapay:pay:coin"]
// Round to 2 dp for display; 6 dp for the scaled settlement amounts so sub-cent
// values don't collapse to 0.
const r2 = (n) => Math.round(n * 100) / 100
const r6 = (n) => Math.round(n * 1e6) / 1e6

// Compact logger: prints "[functionName] message ...". Extra args are appended.
// A leading blank line separates consecutive entries so the log is easy to scan.
function log(fn, message, ...rest) {
  console.log(`\n\n[${fn}] ${message}`, ...rest)
}

// Labeled divider. The SERVER_NAME tag makes this server's log blocks easy to
// tell apart from the auth server's (they interleave under `npm run dev`), and
// dividers bracket the beginning/end of each request and tool call.
const SERVER_NAME = "MCP SERVER"
function divider(title) {
  console.log(`\n========================= ${SERVER_NAME} · ${title} =========================`)
}

// Truncate long tokens for log output so we never dump a full JWT.
function preview(value, n = 24) {
  if (typeof value !== "string") return value
  return value.length <= n ? value : `${value.slice(0, n)}...(${value.length} chars)`
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { id: "cat-apparel", name: "Apparel", slug: "apparel", itemCount: 2 },
  { id: "cat-auth0", name: "Auth0", slug: "auth0", itemCount: 17 },
  { id: "cat-bags", name: "Bags", slug: "bags", itemCount: 3 },
  { id: "cat-drinkware", name: "Drinkware", slug: "drinkware", itemCount: 1 },
  { id: "cat-hats", name: "Hats & Accessories", slug: "hats-accessories", itemCount: 1 },
  { id: "cat-office", name: "Office & Outdoor", slug: "office-outdoor", itemCount: 4 },
  { id: "cat-skyfire", name: "Skyfire & KYAPay", slug: "skyfire-kyapay", itemCount: 5 },
]

const PRODUCTS = [
  {
    id: "prod-hoodie-zip",
    slug: "bella-canvas-full-zip-hoodie",
    name: "Bella+Canvas Unisex Sponge Fleece Full Zip Hoodie",
    price: 45,
    categoryId: "cat-apparel",
    description:
      "A unisex full-zip sponge fleece hoodie with white drawcords, ribbed cuffs, and a retail fit.",
    featured: true,
  },
  {
    id: "prod-hoodie-okta",
    slug: "bella-canvas-black-zip-hoodie-wordmark",
    name: "Bella+Canvas Black Zip Hoodie - Wordmark",
    price: 45,
    categoryId: "cat-apparel",
    description: "A retail-fit unisex black zip hoodie with Okta wordmark styling and a split-pouch pocket.",
    featured: true,
  },
  {
    id: "prod-tee-auth0",
    slug: "auth0-classic-tee",
    name: "Auth0 Classic Tee",
    price: 22,
    categoryId: "cat-auth0",
    description: "Soft cotton crew-neck tee with Auth0 branding.",
    featured: false,
  },
  {
    id: "prod-bottle",
    slug: "okta-insulated-bottle",
    name: "Okta Insulated Water Bottle",
    price: 28,
    categoryId: "cat-drinkware",
    description: "Double-wall vacuum-insulated stainless bottle.",
    featured: true,
  },
  {
    id: "prod-tote",
    slug: "okta-canvas-tote",
    name: "Okta Canvas Tote Bag",
    price: 18,
    categoryId: "cat-bags",
    description: "Heavy-duty canvas tote with reinforced handles.",
    featured: false,
  },
  {
    id: "prod-skyfire-hoodie",
    slug: "skyfire-embroidered-hoodie",
    name: "Skyfire Embroidered Hoodie",
    price: 48,
    categoryId: "cat-skyfire",
    description: "Midnight-navy fleece hoodie with a tonal embroidered Skyfire logo on the chest.",
    featured: true,
  },
  {
    id: "prod-skyfire-tee",
    slug: "skyfire-logo-tee",
    name: "Skyfire Logo Tee",
    price: 24,
    categoryId: "cat-skyfire",
    description: "Soft tri-blend crew-neck tee with the Skyfire wordmark across the front.",
    featured: false,
  },
  {
    id: "prod-skyfire-cap",
    slug: "skyfire-dad-cap",
    name: "Skyfire Dad Cap",
    price: 26,
    categoryId: "cat-skyfire",
    description: "Unstructured cotton dad cap with an embroidered Skyfire mark and an adjustable strap.",
    featured: false,
  },
  {
    id: "prod-kyapay-tee",
    slug: "i-love-kyapay-tee",
    name: "I ♥ KYAPay Tee",
    price: 25,
    categoryId: "cat-skyfire",
    description: "Cotton crew-neck tee with a bold \"I ♥ KYAPay\" print — for agents who love getting paid.",
    featured: true,
  },
  {
    id: "prod-kyapay-mug",
    slug: "i-love-kyapay-mug",
    name: "I ♥ KYAPay Mug",
    price: 16,
    categoryId: "cat-skyfire",
    description: "11oz ceramic mug printed with \"I ♥ KYAPay\" — settle your morning coffee in one tap.",
    featured: false,
  },
]

// In-memory per-session state. Keyed by session id (or a default).
const carts = new Map()
const orders = new Map()
let orderSeq = 1000

function cartFor(session) {
  if (!carts.has(session)) {
    log("cartFor", "creating new cart for session", { session })
    carts.set(session, [])
  }
  return carts.get(session)
}

// ---------------------------------------------------------------------------
// Tool catalog (open vs protected)
// ---------------------------------------------------------------------------

const OPEN_TOOLS = new Set(["getCategories", "getFeaturedProducts", "getProduct", "searchProducts", "getCart"])

const TOOLS = [
  {
    name: "getCategories",
    description: "Get all available swag categories",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "getFeaturedProducts",
    description: "Get featured swag for the homepage",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 50, default: 8 } },
      additionalProperties: false,
    },
  },
  {
    name: "getProduct",
    description: "Get detailed information about a specific product",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Product slug identifier" } },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "searchProducts",
    description: "Search for Auth0 and Okta swag in the catalog",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term for swag" },
        categoryId: { type: "string" },
        minPrice: { type: "number" },
        maxPrice: { type: "number" },
        limit: { type: "number", minimum: 1, maximum: 50, default: 12 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "getCart",
    description: "Get current cart contents",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "addToCart",
    description: "Add a swag item to the cart",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "ID of the product to add" },
        quantity: { type: "number", minimum: 1, description: "Quantity to add" },
      },
      required: ["productId", "quantity"],
      additionalProperties: false,
    },
  },
  {
    name: "removeFromCart",
    description: "Remove a swag item from the cart",
    inputSchema: {
      type: "object",
      properties: { productId: { type: "string", description: "ID of the product to remove" } },
      required: ["productId"],
      additionalProperties: false,
    },
  },
  {
    name: "clearCart",
    description: "Clear all items from the cart",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "checkout",
    description:
      "Quote the current cart: returns the order summary (items, subtotal, tax, shipping, total). Present it to the user and ask for confirmation BEFORE calling pay.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "pay",
    description:
      "Complete payment for the current cart. The payment token is supplied automatically by the payment gateway via _meta; confirm the order total with the user before calling pay.",
    inputSchema: {
      type: "object",
      properties: {
        shippingAddress: { type: "string", description: "Shipping address (optional)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "getOrder",
    description: "Get order details and status",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "number", description: "Order ID to retrieve" } },
      required: ["orderId"],
      additionalProperties: false,
    },
  },
  {
    name: "getPreviousOrders",
    description: "Get user's order history with pagination support",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 50, default: 10 },
        offset: { type: "number", minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
  },
]

// ---------------------------------------------------------------------------
// Tool handlers. Return a JSON-RPC result object: { content, isError? }.
// ---------------------------------------------------------------------------

const ok = (text) => ({ content: [{ type: "text", text }] })
const fail = (text) => ({ content: [{ type: "text", text }], isError: true })

// Build the payments/* signal the opencode gateway settles. COIN-suffixed types
// carry an accepted-issuer constraint (closed-loop); card-style types would not.
// Shape mirrors merchant.js and matches the gateway's parsePaymentSignal.
function paymentSignal(total, subTotal, taxes, shipping) {
  const issuersByType = {}
  for (const type of ACCEPTED_SETTLEMENT_TYPES) {
    if (type.endsWith(":coin")) issuersByType[type] = ACCEPTED_ISSUERS
  }
  return {
    "payments/settlement/types": ACCEPTED_SETTLEMENT_TYPES,
    "payments/settlement/issuers": issuersByType,
    "payments/settlement/currency": SETTLEMENT_CURRENCY,
    "payments/amount/total": total,
    "payments/amount/sub-total": subTotal,
    "payments/amount/taxes": taxes,
    "payments/amount/shipping_and_handling": shipping,
    "payments/settlement/seller_service_id": SELLER_SERVICE_ID,
    "payments/settlement/seller_search": SELLER_SEARCH_HINT,
  }
}

// Charge a Skyfire pay token for `amount` via the Skyfire REST API. Ported from
// merchant.js: POST { token, chargeAmount } to /api/v1/tokens/charge with the
// seller API key. Returns { ok, body } on success, { ok: false, error } otherwise.
async function chargeSkyfireToken(token, amount) {
  const url = `${SKYFIRE_API_BASE_URL}/api/v1/tokens/charge`
  log("chargeSkyfireToken", "════ charge BEGIN ════", {
    url,
    chargeAmount: String(amount),
    token: preview(token),
    tokenLength: typeof token === "string" ? token.length : undefined,
  })
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "skyfire-api-key": SKYFIRE_SELLER_API_KEY,
    },
    body: JSON.stringify({ token, chargeAmount: String(amount) }),
  })
  const body = await response.text()
  if (response.ok) {
    log("chargeSkyfireToken", "════ charge OK ════", { status: response.status, body: preview(body, 200) })
    return { ok: true, body }
  }
  const error = body || `Skyfire charge failed with status ${response.status}`
  log("chargeSkyfireToken", "════ charge FAILED ════", { status: response.status, error: preview(error, 200) })
  return { ok: false, error }
}

async function callTool(name, args, ctx) {
  log("callTool", "dispatching tool", { name, args, authed: ctx.authed, session: ctx.session })

  if (name === "getCategories") {
    log("callTool", "getCategories: returning categories", { count: CATEGORIES.length })
    const lines = CATEGORIES.map(
      (c) => `- ${c.name} (ID: ${c.id}, Slug: ${c.slug}) - ${c.itemCount} swag items`,
    ).join("\n")
    return ok(`Found ${CATEGORIES.length} categories:\n${lines}`)
  }

  if (name === "getFeaturedProducts") {
    const limit = Number.isFinite(args.limit) ? args.limit : 8
    const featured = PRODUCTS.filter((p) => p.featured).slice(0, limit)
    log("callTool", "getFeaturedProducts: returning featured items", { limit, count: featured.length })
    if (featured.length === 0) return ok("No featured swag items.")
    const lines = featured
      .map((p) => `  - ${p.name} (ID: ${p.id}, Slug: ${p.slug}) - $${p.price.toFixed(2)}`)
      .join("\n")
    return ok(`Found ${featured.length} featured swag items:\n${lines}`)
  }

  if (name === "getProduct") {
    const product = PRODUCTS.find((p) => p.slug === args.slug)
    if (!product) {
      log("callTool", "getProduct: no match", { slug: args.slug })
      return fail(`No product found for slug "${args.slug}".`)
    }
    log("callTool", "getProduct: found", { slug: args.slug, id: product.id })
    return ok(JSON.stringify({ ...product, price: `$${product.price.toFixed(2)}` }, null, 2))
  }

  if (name === "searchProducts") {
    const q = String(args.query ?? "").toLowerCase()
    const limit = Number.isFinite(args.limit) ? args.limit : 12
    let results = PRODUCTS.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    )
    if (args.categoryId) results = results.filter((p) => p.categoryId === args.categoryId)
    if (Number.isFinite(args.minPrice)) results = results.filter((p) => p.price >= args.minPrice)
    if (Number.isFinite(args.maxPrice)) results = results.filter((p) => p.price <= args.maxPrice)
    results = results.slice(0, limit)
    log("callTool", "searchProducts: search complete", { query: args.query, matches: results.length })
    if (results.length === 0) return ok(`No swag found matching "${args.query}".`)
    const lines = results
      .map((p) => `  - ${p.name} (ID: ${p.id}, Slug: ${p.slug}) - $${p.price.toFixed(2)} - ${p.description}`)
      .join("\n")
    return ok(`Found ${results.length} swag items matching "${args.query}":\n${lines}`)
  }

  if (name === "getCart") {
    // Open tool, but degrades to a sign-in prompt when unauthenticated —
    // matching the real server's "Sign in to start adding items" response.
    if (!ctx.authed) {
      log("callTool", "getCart: unauthenticated, returning sign-in prompt")
      return ok("Your cart is empty. Sign in to start adding items.")
    }
    const cart = cartFor(ctx.session)
    log("callTool", "getCart: returning cart", { session: ctx.session, items: cart.length })
    if (cart.length === 0) return ok("Your cart is empty.")
    const lines = cart
      .map((i) => `  - ${i.quantity}x ${i.name} @ $${i.price.toFixed(2)}`)
      .join("\n")
    const total = cart.reduce((s, i) => s + i.price * i.quantity, 0)
    return ok(`Cart contents:\n${lines}\n  Total: $${total.toFixed(2)}`)
  }

  if (name === "addToCart") {
    const product = PRODUCTS.find((p) => p.id === args.productId)
    if (!product) {
      log("callTool", "addToCart: unknown product", { productId: args.productId })
      return fail(`Unknown product: ${args.productId}`)
    }
    const quantity = Number.isFinite(args.quantity) && args.quantity >= 1 ? Math.floor(args.quantity) : 1
    const cart = cartFor(ctx.session)
    const existing = cart.find((i) => i.productId === args.productId)
    if (existing) existing.quantity += quantity
    else cart.push({ productId: product.id, name: product.name, price: product.price, quantity })
    log("callTool", "addToCart: item added", { productId: product.id, quantity, cartItems: cart.length })
    return ok(`Added ${quantity}x "${product.name}" to your cart.`)
  }

  if (name === "removeFromCart") {
    const cart = cartFor(ctx.session)
    const idx = cart.findIndex((i) => i.productId === args.productId)
    if (idx === -1) {
      log("callTool", "removeFromCart: item not in cart", { productId: args.productId })
      return fail(`Item not in cart: ${args.productId}`)
    }
    const [removed] = cart.splice(idx, 1)
    log("callTool", "removeFromCart: item removed", { productId: args.productId, cartItems: cart.length })
    return ok(`Removed "${removed.name}" from your cart.`)
  }

  if (name === "clearCart") {
    log("callTool", "clearCart: clearing cart", { session: ctx.session })
    carts.set(ctx.session, [])
    return ok("Cart cleared.")
  }

  if (name === "checkout") {
    const cart = cartFor(ctx.session)
    if (cart.length === 0) {
      log("callTool", "checkout: cart empty, rejecting")
      return fail("Cart is empty. Add items before checkout.")
    }
    // Quote only — deliberately a normal (non-error) result with NO payments/*
    // signal. The order is created and the cart cleared in `pay`, after the
    // gateway settles. Emitting the signal here would authorize payment before
    // the user confirms.
    const subTotal = r2(cart.reduce((s, i) => s + i.price * i.quantity, 0))
    const taxes = r2(subTotal * TAX_RATE)
    const total = r2(subTotal + taxes + SHIPPING_FLAT)
    const items = cart.map((i) => `  - ${i.quantity}x ${i.name} @ $${i.price.toFixed(2)}`).join("\n")
    log("callTool", "checkout: quoted cart", { subTotal, taxes, total, items: cart.length })
    return ok(
      [
        "Order summary:",
        items,
        `  Subtotal: $${subTotal.toFixed(2)}`,
        `  Taxes: $${taxes.toFixed(2)}`,
        `  Shipping: $${SHIPPING_FLAT.toFixed(2)}`,
        `  Total: $${total.toFixed(2)}`,
        "",
        "Confirm these details with the user, then call `pay` to complete the purchase.",
      ].join("\n"),
    )
  }

  if (name === "pay") {
    const cart = cartFor(ctx.session)
    if (cart.length === 0) {
      log("callTool", "pay: cart empty, nothing to pay for")
      return fail("Cart is empty. Nothing to pay for.")
    }
    const subTotal = r2(cart.reduce((s, i) => s + i.price * i.quantity, 0))
    const taxes = r2(subTotal * TAX_RATE)
    const total = r2(subTotal + taxes + SHIPPING_FLAT)

    const payToken = ctx.meta?.["payments/settlement/token"]
    const settlementType = ctx.meta?.["payments/settlement/type"]

    if (!payToken || typeof payToken !== "string") {
      // No token yet — return the payment signal so the gateway resolves a
      // settlement type, mints a pay token via the issuer, and retries `pay`.
      // The signal carries the SCALED (sub-cent) amounts so the minted token fits
      // the Skyfire balance; the user-facing text still shows the real dollar total.
      const settleSubTotal = r6(subTotal * SETTLEMENT_SCALE)
      const settleTaxes = r6(taxes * SETTLEMENT_SCALE)
      const settleShipping = r6(SHIPPING_FLAT * SETTLEMENT_SCALE)
      const settleTotal = r6(total * SETTLEMENT_SCALE)
      log("callTool", "════ pay: no payment token → emitting payments/* required signal ════", {
        displayTotal: total,
        settleTotal,
        scale: SETTLEMENT_SCALE,
      })
      return {
        content: [{ type: "text", text: `Payment Required: $${total.toFixed(2)}` }],
        isError: true,
        _meta: paymentSignal(settleTotal, settleSubTotal, settleTaxes, settleShipping),
      }
    }

    // Token present — validate (decode + expiry) and confirm the order. As in
    // merchant.js, the mock only decodes the JWT and checks expiry; it does not
    // re-verify the issuer signature here.
    const payload = decodeJwtPayload(payToken)
    if (!payload) {
      log("callTool", "pay: payment token could not be decoded")
      return fail("Invalid payment token: could not decode JWT.")
    }
    const now = Math.floor(Date.now() / 1000)
    if (typeof payload.exp === "number" && payload.exp <= now) {
      log("callTool", "pay: payment token expired", { exp: payload.exp, now })
      return fail("Payment token has expired.")
    }

    if (settlementType && !ACCEPTED_SETTLEMENT_TYPES.includes(settlementType)) {
      log("callTool", "pay: unsupported settlement type", { settlementType })
      return fail(`Unsupported settlement type: ${String(settlementType)}`)
    }

    // Actually charge the pay token via Skyfire (mirrors merchant.js). The token
    // was minted for the SCALED (sub-cent) amount, so charge that — not the real
    // dollar total — or the charge would exceed what the token authorized.
    const settleTotal = r6(total * SETTLEMENT_SCALE)
    log("callTool", "pay: charging pay token via Skyfire", { settlementType, settleTotal, displayTotal: total })
    const charge = await chargeSkyfireToken(payToken, settleTotal)
    if (!charge.ok) {
      log("callTool", "pay: charge failed, aborting order", { error: preview(charge.error, 200) })
      return fail(`Payment charge failed: ${charge.error}`)
    }
    log("callTool", "pay: charge succeeded, confirming order")

    const orderId = ++orderSeq
    const items = cart.map((i) => ({ ...i }))
    orders.set(orderId, {
      orderId,
      status: "PAID",
      items,
      subTotal,
      taxes,
      shipping: SHIPPING_FLAT,
      total,
      currency: SETTLEMENT_CURRENCY,
      settlementType: typeof settlementType === "string" ? settlementType : null,
    })
    carts.set(ctx.session, [])
    log("callTool", "════ pay: settlement confirmed — order PAID ════", { orderId, total, settlementType })
    const lines = items.map((i) => `  - ${i.quantity}x ${i.name} @ $${i.price.toFixed(2)}`).join("\n")
    const shipTo =
      typeof args.shippingAddress === "string" && args.shippingAddress.trim()
        ? args.shippingAddress
        : "123 Demo St, San Francisco, CA 94102"
    return ok(
      [
        "Order confirmed!",
        `  Order ID: ${orderId}`,
        "  Items:",
        lines,
        `  Subtotal: $${subTotal.toFixed(2)}`,
        `  Taxes: $${taxes.toFixed(2)}`,
        `  Shipping: $${SHIPPING_FLAT.toFixed(2)}`,
        `  Total: $${total.toFixed(2)}`,
        `  Payment: Charged via Skyfire${settlementType ? ` (${settlementType})` : ""}`,
        `  Shipping to: ${shipTo}`,
        "  Status: PAID",
      ].join("\n"),
    )
  }

  if (name === "getOrder") {
    const order = orders.get(Number(args.orderId))
    if (!order) {
      log("callTool", "getOrder: not found", { orderId: args.orderId })
      return fail(`Order not found: ${args.orderId}`)
    }
    log("callTool", "getOrder: found", { orderId: order.orderId, status: order.status })
    return ok(JSON.stringify(order, null, 2))
  }

  if (name === "getPreviousOrders") {
    const limit = Number.isFinite(args.limit) ? args.limit : 10
    const offset = Number.isFinite(args.offset) ? args.offset : 0
    const all = [...orders.values()].sort((a, b) => b.orderId - a.orderId)
    const page = all.slice(offset, offset + limit)
    log("callTool", "getPreviousOrders: returning page", { limit, offset, total: all.length, returned: page.length })
    if (page.length === 0) return ok("No previous orders.")
    return ok(
      `Found ${page.length} orders:\n` +
        page.map((o) => `  - Order ${o.orderId}: $${o.total.toFixed(2)} (${o.status})`).join("\n"),
    )
  }

  log("callTool", "unknown tool", { name })
  return fail(`Unknown tool: ${String(name)}`)
}

// ---------------------------------------------------------------------------
// HTTP / MCP plumbing
// ---------------------------------------------------------------------------

function json(res, status, body, headers) {
  res.writeHead(status, { "content-type": "application/json", ...(headers ?? {}) })
  res.end(JSON.stringify(body))
}

function text(res, status, body, headers) {
  res.writeHead(status, { "content-type": "text/plain", ...(headers ?? {}) })
  res.end(body)
}

function bearer(req) {
  const auth = req.headers.authorization
  log("bearer", "extracting Bearer token from Authorization header", { auth })
  if (!auth?.startsWith("Bearer ")) {
    log("bearer", "no Bearer authorization header present")
    return undefined
  }
  return auth.slice("Bearer ".length)
}

// Verify an HS256 access_token issued by the mock auth server: signature, issuer,
// audience, and expiry. Returns the payload on success, undefined otherwise.
function verifyAccessToken(token) {
  const [h, p, s] = token.split(".")
  if (!h || !p || !s) {
    log("verifyAccessToken", "rejected: malformed token (expected 3 parts)")
    return
  }
  const expected = crypto.createHmac("sha256", accessTokenSecret).update(`${h}.${p}`).digest("base64url")
  if (expected !== s) {
    log("verifyAccessToken", "rejected: signature mismatch (wrong ACCESS_TOKEN_SECRET?)")
    return
  }
  let payload
  try {
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"))
  } catch {
    log("verifyAccessToken", "rejected: payload is not valid JSON")
    return
  }
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp === "number" && payload.exp <= now) {
    log("verifyAccessToken", "rejected: token expired", { exp: payload.exp, now })
    return
  }
  if (payload.iss !== authServer) {
    log("verifyAccessToken", "rejected: issuer mismatch", { iss: payload.iss, expected: authServer })
    return
  }
  if (payload.aud !== resourceUri) {
    log("verifyAccessToken", "rejected: audience mismatch", { aud: payload.aud, expected: resourceUri })
    return
  }
  // The auth server mints "openid profile email mcp" from a KYA exchange, so a token
  // without `mcp` didn't come through the KYA path we expect.
  const scope = typeof payload.scope === "string" ? payload.scope : ""
  if (!scope.split(/\s+/).includes("mcp")) {
    log("verifyAccessToken", "rejected: missing required scope", { scope, required: "mcp" })
    return
  }
  log("verifyAccessToken", "token accepted", { sub: payload.sub, scope: payload.scope, exp: payload.exp })
  return payload
}

// Decode a JWT payload for inspection only (no signature/claim verification).
// Used by `pay` to read the gateway-supplied pay token's `exp`.
function decodeJwtPayload(token) {
  const p = typeof token === "string" ? token.split(".")[1] : undefined
  if (!p) return undefined
  try {
    return JSON.parse(Buffer.from(p, "base64url").toString("utf8"))
  } catch {
    return undefined
  }
}

function tokenValid(token) {
  if (!requireAuth) {
    log("tokenValid", "auth disabled (REQUIRE_AUTH=0), treating as valid")
    return true
  }
  if (!token) {
    log("tokenValid", "no token supplied")
    return false
  }
  if (acceptAnyToken) {
    log("tokenValid", "ACCEPT_ANY_TOKEN=1, accepting any non-empty token", { token: preview(token) })
    return token.length > 0
  }
  return !!verifyAccessToken(token)
}

// CORS headers, matching the real server (which echoes a permissive policy).
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "*",
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", publicBaseUrl)
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

  // RFC 9728 — OAuth 2.0 Protected Resource Metadata. Shape copied from the real
  // XYZ-Clothiers server: resource is the /mcp URL, plus resource_name and
  // scopes_supported. authorization_servers points at the configured AS.
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    log("handleResourceMetadata", "serving protected-resource metadata (RFC 9728)", { authServer })
    return json(
      res,
      200,
      {
        resource: resourceUri,
        authorization_servers: [authServer],
        resource_name: RESOURCE_NAME,
        scopes_supported: SCOPES_SUPPORTED,
      },
      CORS,
    )
  }

  // RFC 8414 — Authorization Server Metadata. This resource server does NOT mint
  // tokens; the AS is a separate origin (auth-server.js, default :8788). The
  // discovery chain already points clients there via the resource_metadata
  // `authorization_servers` pointer, so if anything fetches this directly we just
  // mirror the real AS's endpoints rather than advertising routes this server
  // doesn't implement. (The real XYZ-Clothiers server delegates to an Auth0 tenant.)
  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration")
  ) {
    log("handleASMetadata", "serving AS metadata (RFC 8414) pointing at auth server", { path: url.pathname, authServer })
    return json(
      res,
      200,
      {
        issuer: authServer,
        authorization_endpoint: `${authServer}/authorize`,
        token_endpoint: `${authServer}/oauth/token`,
        registration_endpoint: `${authServer}/register`,
        response_types_supported: ["code"],
        scopes_supported: SCOPES_SUPPORTED,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
        authorization_grant_profiles_supported: [
          "urn:ietf:params:oauth:grant-profile:id-jag",
          "urn:ietf:params:oauth:grant-profile:kya",
        ],
      },
      CORS,
    )
  }

  if (req.method !== "POST" || url.pathname !== "/mcp") {
    log("handleRequest", "no route matched, replying 404", { method: req.method, path: url.pathname })
    return text(res, 404, "Not found")
  }

  const token = bearer(req)
  const authed = tokenValid(token)
  log("handleMcp", "MCP request authentication", { hasToken: !!token, authed })

  // Open browsing is unauthenticated: initialize, tools/list, notifications, and
  // every OPEN_TOOLS call work with no token. Auth is enforced per-tool below, so
  // a client connects freely, browses the catalog, and only hits a 401 when it
  // first calls a PROTECTED tool (e.g. addToCart) — which is what kicks off the
  // KYA token exchange.

  let raw = ""
  req.on("data", (c) => (raw += c))
  req.on("end", async () => {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      log("handleMcp", "rejected: request body is not valid JSON")
      return json(res, 400, { error: "invalid_json" })
    }

    const id = parsed?.id ?? 1
    const method = parsed?.method
    const session = req.headers["mcp-session-id"] ?? "default"
    log("handleMcp", "JSON-RPC request", { id, method, tool: parsed?.params?.name, session })

    if (method === "initialize") {
      log("handleMcp", "initialize → returning serverInfo")
      return json(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: parsed?.params?.protocolVersion ?? "2024-11-05",
          serverInfo: { name: "xyz-clothiers-mock", version: "1.0.0" },
          capabilities: { tools: {} },
        },
      })
    }

    if (typeof method === "string" && method.startsWith("notifications/")) {
      log("handleMcp", "notification received, replying 202", { method })
      res.writeHead(202)
      res.end()
      return
    }

    if (method === "tools/list") {
      log("handleMcp", "tools/list → returning catalog", { count: TOOLS.length })
      return json(res, 200, { jsonrpc: "2.0", id, result: { tools: TOOLS } })
    }

    if (method === "tools/call") {
      const name = parsed?.params?.name
      const args = parsed?.params?.arguments ?? {}
      const meta = parsed?.params?._meta
      const isOpen = OPEN_TOOLS.has(name)
      divider(`TOOL CALL ▶ ${name}`)
      log("handleMcp", "tool call REQUEST", { name, open: isOpen, authed, arguments: args })
      // Gate protected tools. With no valid access token, return a real HTTP 401
      // + WWW-Authenticate challenge (RFC 9728) so the client kicks off the KYA
      // token exchange: discover the AS → mint a Skyfire KYA token → exchange it
      // for an access token → retry the call with `Authorization: Bearer ...`.
      if (requireAuth && !isOpen && !authed) {
        const challenge = `Bearer realm="mcp", resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource", authorization-uri="${authServer}/.well-known/oauth-authorization-server"`
        log("handleMcp", "════════ PROTECTED TOOL CALLED WITHOUT VALID TOKEN ════════", {
          name,
          hasToken: !!token,
          reason: token ? "token present but invalid/expired" : "no token",
        })
        log("handleMcp", "→ replying 401 + WWW-Authenticate to trigger KYA token exchange", { name, challenge })
        divider(`TOOL CALL END ◀ ${name} (401)`)
        return text(res, 401, "Unauthorized", { "www-authenticate": challenge, ...CORS })
      }
      if (!isOpen) log("handleMcp", "✓ protected tool authorized — KYA access token accepted", { name })
      const result = await callTool(name, args, { authed, session, token, meta })
      const responseText = (result.content ?? [])
        .map((c) => (typeof c?.text === "string" ? c.text : JSON.stringify(c)))
        .join("\n")
      log("handleMcp", "tool call RESPONSE", { name, isError: !!result.isError, content: responseText })
      divider(`TOOL CALL END ◀ ${name}`)
      return json(res, 200, { jsonrpc: "2.0", id, result })
    }

    log("handleMcp", "unknown JSON-RPC method", { method })
    return json(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } })
  })
})

server.listen(port, host, () => {
  log("listen", `MCP server listening on ${host}:${port}`)
  log("listen", `MCP endpoint:  ${publicBaseUrl}/mcp`)
  log("listen", `resource meta: ${publicBaseUrl}/.well-known/oauth-protected-resource`)
  log("listen", `AS metadata:   ${authServer}/.well-known/oauth-authorization-server`)
  log("listen", `auth server:   ${authServer} (issues access tokens)`)
  log("listen", `auth required: ${requireAuth} (set REQUIRE_AUTH=0 to disable)`)
})
