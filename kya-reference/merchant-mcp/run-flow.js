#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { fileURLToPath } from "url"
import path from "path"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(__dirname, "merchant.js")],
    stderr: "pipe",
  })

  const client = new Client({ name: "cli-client", version: "1.0.0" })
  await client.connect(transport)

  // 1. Search for GPU products
  console.log("🔍 Searching for GPU products...")
  const searchResult = await client.callTool(
    { name: "search-for-products", arguments: { query: "GPU" } },
    CallToolResultSchema,
  )
  console.log(searchResult.content[0].text, "\n")

  // 2. Add GPU Compute Credits to cart
  console.log("🛒 Adding GPU Compute Credits to cart...")
  const addResult = await client.callTool(
    { name: "add-to-cart", arguments: { product_id: "PROD-003", quantity: 1 } },
    CallToolResultSchema,
  )
  console.log(addResult.content[0].text, "\n")

  // 3. Checkout with shipping address
  console.log("🧾 Checking out...")
  const checkoutResult = await client.callTool(
    {
      name: "pay",
      arguments: { shipping_address: "123 Demo St, San Francisco, CA 94102" },
    },
    CallToolResultSchema,
  )

  if (checkoutResult.isError) {
    // Payment signal returned — show it
    const meta = checkoutResult._meta ?? {}
    console.log(checkoutResult.content[0].text)
    console.log("\nPayment required meta:", JSON.stringify(meta, null, 2))
    console.log("\n⚠️  Gateway auto-resolve is enabled in opencode.jsonc")
    console.log("   The gateway will autonomously call Skyfire to get a pay token")
    console.log("   and retry the pay tool with the token injected in _meta.\n")

    // Simulate gateway retry with a test token to show the full flow
    console.log("🔄 Simulating gateway retry with payment token...")
    const header = { alg: "none", typ: "JWT" }
    const payload = {
      sub: "test-buyer",
      amount: meta["payments/amount/total"],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }
    const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url")
    const testToken = `${encode(header)}.${encode(payload)}.test-signature`

    const payResult = await client.request(
      {
        method: "tools/call",
        params: {
          name: "pay",
          arguments: { shipping_address: "123 Demo St, San Francisco, CA 94102" },
          _meta: {
            "payments/settlement/type": meta["payments/settlement/types"][0],
            "payments/settlement/token": testToken,
            "payments/amount/total": meta["payments/amount/total"],
            "payments/settlement/currency": "USD",
          },
        },
      },
      CallToolResultSchema,
    )

    console.log(payResult.content[0].text)
  } else {
    console.log(checkoutResult.content[0].text)
  }

  await client.close()
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
