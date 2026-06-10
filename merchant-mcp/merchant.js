#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Merchant configuration
// ---------------------------------------------------------------------------

// The merchant's identity on the payment network (Skyfire). The token issuer
// requires this to mint a pay token. Replace with the real Skyfire
// sellerServiceId (discoverable via Skyfire's find-sellers tool).
const SELLER_SERVICE_ID = "223bc3eb-9bcb-4e9b-afd6-f26ee0bd3894"
// Optional search hint the gateway can use to look the seller up via
// find-sellers if SELLER_SERVICE_ID is not a valid network id.
const SELLER_SEARCH_HINT = "Cloud API and GPU compute merchant"
const TAX_RATE = 0.08
const SHIPPING_FLAT = 0.001

// Round to 6 decimal places so sub-cent prices don't collapse to $0.00.
const r6 = (n) => Math.round(n * 1e6) / 1e6
const ACCEPTED_SETTLEMENT_TYPES = ["org.kyapay:kya-pay:card", "org.kyapay:pay:card"]

// ---------------------------------------------------------------------------
// Product catalog
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const carts = new Map()
let orderSeq = 1000

function decodeJwtPayload(token) {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "merchant-mcp-server",
  version: "2.0.0",
  capabilities: { tools: {} },
})

// ---------------------------------------------------------------------------
// Tool: search-for-products
// ---------------------------------------------------------------------------

server.tool(
  "search-for-products",
  "Search the product catalog. Returns matching products with IDs and prices.",
  {
    query: z.string().describe("Search query (matched against product name and description)"),
  },
  async (args) => {
    const q = args.query.toLowerCase()
    const results = CATALOG.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
    return {
      content: [
        {
          type: "text",
          text: results.length > 0 ? JSON.stringify(results, null, 2) : `No products found matching "${args.query}".`,
        },
      ],
    }
  },
)

// ---------------------------------------------------------------------------
// Tool: product-details
// ---------------------------------------------------------------------------

server.tool(
  "product-details",
  "Get full details for a specific product by its ID.",
  {
    product_id: z.string().describe("The product ID (e.g. PROD-001)"),
  },
  async (args) => {
    const product = CATALOG.find((p) => p.id === args.product_id)
    if (!product) {
      return {
        content: [{ type: "text", text: `Unknown product: ${args.product_id}` }],
        isError: true,
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify(product, null, 2) }],
    }
  },
)

// ---------------------------------------------------------------------------
// Tool: add-to-cart
// ---------------------------------------------------------------------------

server.tool(
  "add-to-cart",
  "Add a product to the shopping cart. Creates a new cart if none exists.",
  {
    product_id: z.string().describe("The product ID to add"),
    quantity: z.number().int().min(1).default(1).describe("Quantity to add (default: 1)"),
  },
  async (args) => {
    const product = CATALOG.find((p) => p.id === args.product_id)
    if (!product) {
      return {
        content: [{ type: "text", text: `Unknown product: ${args.product_id}` }],
        isError: true,
      }
    }

    // Use a single default cart for simplicity
    const cartId = "cart-default"
    if (!carts.has(cartId)) carts.set(cartId, [])

    const cart = carts.get(cartId)
    const existing = cart.find((item) => item.product_id === args.product_id)
    if (existing) {
      existing.quantity += args.quantity
    } else {
      cart.push({ product_id: args.product_id, name: product.name, price: product.price, quantity: args.quantity })
    }

    return {
      content: [
        {
          type: "text",
          text: `Added ${args.quantity}x "${product.name}" to cart (${cartId}).\n\nCart contents:\n${JSON.stringify(cart, null, 2)}`,
        },
      ],
    }
  },
)

// ---------------------------------------------------------------------------
// Tool: checkout
// ---------------------------------------------------------------------------

server.tool(
  "checkout",
  "Calculate the final order total and return payment requirements. This tool returns how the merchant accepts payment.",
  {
    shipping_address: z.string().describe("Full shipping address"),
    billing_address: z.string().optional().describe("Billing address (defaults to shipping address)"),
  },
  async (args) => {
    const cartId = "cart-default"
    const cart = carts.get(cartId)
    if (!cart || cart.length === 0) {
      return {
        content: [{ type: "text", text: "Cart is empty. Add products before checkout." }],
        isError: true,
      }
    }

    const subTotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0)
    const taxes = r6(subTotal * TAX_RATE)
    const total = r6(subTotal + taxes + SHIPPING_FLAT)

    // Return the payment-required signal per spec
    return {
      content: [
        {
          type: "text",
          text: `Payment Required: $${total} (subtotal $${subTotal} + tax $${taxes} + shipping $${SHIPPING_FLAT})`,
        },
      ],
      isError: true,
      _meta: {
        "payments/settlement/types": ACCEPTED_SETTLEMENT_TYPES,
        "payments/settlement/currency": "USD",
        "payments/amount/total": total,
        "payments/amount/sub-total": subTotal,
        "payments/amount/taxes": taxes,
        "payments/amount/shipping_and_handling": SHIPPING_FLAT,
        "payments/settlement/seller_service_id": SELLER_SERVICE_ID,
        "payments/settlement/seller_search": SELLER_SEARCH_HINT,
      },
    }
  },
)

// ---------------------------------------------------------------------------
// Tool: pay
// ---------------------------------------------------------------------------

server.tool(
  "pay",
  "Complete payment for the current checkout. Accepts a payment token via _meta as provided by the payment gateway.",
  {
    shipping_address: z.string().describe("Full shipping address"),
    billing_address: z.string().optional().describe("Billing address (defaults to shipping address)"),
  },
  async (args, extra) => {
    const cartId = "cart-default"
    const cart = carts.get(cartId)
    if (!cart || cart.length === 0) {
      return {
        content: [{ type: "text", text: "Cart is empty. Nothing to pay for." }],
        isError: true,
      }
    }

    // Check for payment token in _meta
    const meta = extra?._meta
    const payToken = meta?.["payments/settlement/token"]
    const settlementType = meta?.["payments/settlement/type"]

    if (!payToken || typeof payToken !== "string") {
      // No token yet — return the payment signal so the gateway can resolve it
      const subTotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0)
      const taxes = Math.round(subTotal * TAX_RATE * 100) / 100
      const total = Math.round((subTotal + taxes + SHIPPING_FLAT) * 100) / 100

      return {
        content: [
          {
            type: "text",
            text: `Payment Required: $${total}`,
          },
        ],
        isError: true,
        _meta: {
          "payments/settlement/types": ACCEPTED_SETTLEMENT_TYPES,
          "payments/settlement/currency": "USD",
          "payments/amount/total": total,
          "payments/amount/sub-total": subTotal,
          "payments/amount/taxes": taxes,
          "payments/amount/shipping_and_handling": SHIPPING_FLAT,
          "payments/settlement/seller_service_id": SELLER_SERVICE_ID,
          "payments/settlement/seller_search": SELLER_SEARCH_HINT,
        },
      }
    }

    // Token present — validate it
    const payload = decodeJwtPayload(payToken)
    if (!payload) {
      return {
        content: [{ type: "text", text: "Invalid payment token: could not decode JWT." }],
        isError: true,
      }
    }

    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) {
      return {
        content: [{ type: "text", text: "Payment token has expired." }],
        isError: true,
      }
    }

    // Calculate totals
    const subTotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0)
    const taxes = r6(subTotal * TAX_RATE)
    const total = r6(subTotal + taxes + SHIPPING_FLAT)

    // Clear the cart
    carts.delete(cartId)

    const orderId = `ORD-${++orderSeq}`
    const items = cart.map((item) => `  - ${item.quantity}x ${item.name} @ $${item.price}`).join("\n")

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
            `  Shipping to: ${args.shipping_address}`,
            `  Status: PAID`,
          ].join("\n"),
        },
      ],
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
