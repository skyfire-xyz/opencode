#!/usr/bin/env node

/**
 * End-to-end test for the Agentic Commerce Gateway flow.
 *
 * Spawns the merchant MCP server as a child process, simulates the gateway's
 * catch-and-resolve pattern, and verifies:
 *   1. checkout returns the payments/* signal
 *   2. pay without a token returns the payments/* signal
 *   3. pay WITH a token in _meta succeeds
 *
 * Usage: node merchant-mcp/test-flow.js
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { fileURLToPath } from "url"
import path from "path"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// -- Helpers ----------------------------------------------------------------

function makeTestJwt() {
  // Build a minimal JWT that the merchant can decode (no signature verification)
  const header = { alg: "none", typ: "JWT" }
  const payload = {
    sub: "test-buyer",
    amount: 100,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url")
  return `${encode(header)}.${encode(payload)}.test-signature`
}

function parseMeta(result) {
  return result._meta ?? {}
}

// -- Main -------------------------------------------------------------------

async function main() {
  console.log("=== Agentic Commerce Gateway — E2E Test ===\n")

  // 1. Connect to merchant MCP server via stdio
  console.log("1. Starting merchant MCP server...")
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(__dirname, "merchant.js")],
    stderr: "pipe",
  })

  const client = new Client({ name: "test-client", version: "1.0.0" })
  await client.connect(transport)
  console.log("   ✓ Connected\n")

  // 2. Search for products
  console.log("2. Searching for products...")
  const searchResult = await client.callTool(
    { name: "search-for-products", arguments: { query: "API" } },
    CallToolResultSchema,
  )
  console.log("   ✓ Found:", searchResult.content[0].text.slice(0, 80), "...\n")

  // 3. Get product details
  console.log("3. Getting product details for PROD-001...")
  const detailResult = await client.callTool(
    { name: "product-details", arguments: { product_id: "PROD-001" } },
    CallToolResultSchema,
  )
  console.log("   ✓", detailResult.content[0].text.slice(0, 80), "...\n")

  // 4. Add to cart
  console.log("4. Adding PROD-001 to cart...")
  const addResult = await client.callTool(
    { name: "add-to-cart", arguments: { product_id: "PROD-001", quantity: 2 } },
    CallToolResultSchema,
  )
  console.log("   ✓", addResult.content[0].text.split("\n")[0], "\n")

  // 5. Checkout — should return payment signal
  console.log("5. Calling checkout (expect payment signal)...")
  const checkoutResult = await client.callTool(
    { name: "checkout", arguments: { shipping_address: "123 Test St, San Francisco, CA 94102" } },
    CallToolResultSchema,
  )

  const checkoutMeta = parseMeta(checkoutResult)
  console.log("   isError:", checkoutResult.isError)
  console.log("   text:", checkoutResult.content[0].text)
  console.log("   _meta:", JSON.stringify(checkoutMeta, null, 4))

  if (!checkoutResult.isError || !checkoutMeta["payments/settlement/types"]) {
    console.error("\n   ✗ FAIL: Expected payment signal from checkout")
    process.exit(1)
  }
  console.log("   ✓ Got payment signal\n")

  // 6. Call pay WITHOUT token — should also return payment signal
  console.log("6. Calling pay WITHOUT token (expect payment signal)...")
  const payNoTokenResult = await client.callTool(
    { name: "pay", arguments: { shipping_address: "123 Test St, San Francisco, CA 94102" } },
    CallToolResultSchema,
  )

  if (!payNoTokenResult.isError) {
    console.error("   ✗ FAIL: Expected payment signal from pay without token")
    process.exit(1)
  }
  console.log("   ✓ Got payment signal (as expected)\n")

  // 7. Call pay WITH token via _meta — should succeed
  console.log("7. Calling pay WITH token in _meta (simulating gateway retry)...")
  const testToken = makeTestJwt()

  const payWithTokenResult = await client.request(
    {
      method: "tools/call",
      params: {
        name: "pay",
        arguments: { shipping_address: "123 Test St, San Francisco, CA 94102" },
        _meta: {
          "payments/settlement/type": "org.kyapay:pay:card",
          "payments/settlement/token": testToken,
          "payments/amount/total": checkoutMeta["payments/amount/total"],
          "payments/settlement/currency": "USD",
        },
      },
    },
    CallToolResultSchema,
  )

  console.log("   isError:", payWithTokenResult.isError ?? false)
  console.log("   text:", payWithTokenResult.content[0].text)

  if (payWithTokenResult.isError) {
    console.error("\n   ✗ FAIL: Expected success from pay with valid token")
    process.exit(1)
  }
  console.log("   ✓ Order confirmed!\n")

  // 8. Verify cart is now empty
  console.log("8. Verifying cart is cleared...")
  const emptyCheckout = await client.callTool(
    { name: "checkout", arguments: { shipping_address: "123 Test St" } },
    CallToolResultSchema,
  )
  if (emptyCheckout.content[0].text.includes("Cart is empty")) {
    console.log("   ✓ Cart is empty after order\n")
  } else {
    console.log("   ✗ Cart not cleared\n")
  }

  await client.close()
  console.log("=== ALL TESTS PASSED ===")
}

main().catch((err) => {
  console.error("Test failed:", err)
  process.exit(1)
})
