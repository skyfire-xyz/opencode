#!/usr/bin/env node

/**
 * Skyfire connectivity + seller-resolution check.
 *
 * Verifies, outside the opencode TUI, that:
 *   1. The API key is valid (find-sellers returns data, not "API Error")
 *   2. There is at least one resolvable sellerServiceId in the directory
 *   3. A pay token can actually be minted for that seller
 *
 * Usage:
 *   node merchant-mcp/verify-skyfire.mjs                 # lists sellers
 *   node merchant-mcp/verify-skyfire.mjs "GPU compute"   # search + mint test token
 *
 * Reads SKYFIRE_URL / SKYFIRE_API_KEY from env, falling back to the values in
 * .opencode/opencode.jsonc.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"

const URL_STR = process.env.SKYFIRE_URL ?? "http://localhost:4000/mcp"
const API_KEY = process.env.SKYFIRE_API_KEY ?? "23e61be4-a440-4fd8-965c-1d4e95c28fc3"
const SEARCH = process.argv[2] ?? ""
const TEST_AMOUNT = "60"

const text = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n")

function extractSellerServiceId(value) {
  if (!value || typeof value !== "object") return undefined
  for (const key of ["sellerServiceId", "serviceId", "id"]) {
    if (typeof value[key] === "string" && value[key]) return value[key]
  }
  return undefined
}

function parseSellers(result) {
  const out = []
  for (const item of result.content ?? []) {
    if (item.type !== "text" || !item.text) continue
    try {
      const parsed = JSON.parse(item.text)
      for (const c of Array.isArray(parsed) ? parsed : [parsed]) {
        const id = extractSellerServiceId(c)
        if (id) out.push({ id, raw: c })
      }
    } catch {}
  }
  return out
}

async function main() {
  console.log(`→ Connecting to ${URL_STR}\n`)
  const transport = new StreamableHTTPClientTransport(new URL(URL_STR), {
    requestInit: { headers: { "skyfire-api-key": API_KEY } },
  })
  const client = new Client({ name: "verify-skyfire", version: "1.0.0" })
  await client.connect(transport)

  // 1. Key sanity: a tool that does NOT hit the upstream API should always work.
  const dt = await client.callTool({ name: "get-current-datetime", arguments: { format: "iso" } }, CallToolResultSchema)
  console.log(`1. MCP server reachable: ${dt.isError ? "✗" : "✓"} (${text(dt).slice(0, 40)})`)

  // 2. Key validity: find-sellers hits the real Skyfire backend.
  const sellers = await client.callTool({ name: "find-sellers", arguments: { search: SEARCH } }, CallToolResultSchema)
  if (sellers.isError) {
    console.log(`2. API key / backend: ✗  find-sellers returned: ${text(sellers)}`)
    console.log("\n   → The key is invalid/expired or the Skyfire backend is unreachable. Fix this first.")
    await client.close()
    process.exit(1)
  }
  const parsed = parseSellers(sellers)
  console.log(`2. API key valid: ✓  find-sellers returned ${parsed.length} seller(s) with an id`)
  for (const s of parsed.slice(0, 10)) {
    console.log(`     • ${s.id}  ${s.raw.name ?? s.raw.title ?? ""}`)
  }
  if (parsed.length === 0) {
    console.log("   (no parseable sellerServiceId — raw output below)")
    console.log("  ", text(sellers).slice(0, 300))
  }

  // 3. Mint a test token for the first resolved seller.
  if (parsed.length > 0) {
    const sid = parsed[0].id
    console.log(`\n3. Minting test pay token for ${sid} (amount ${TEST_AMOUNT})...`)
    const tok = await client.callTool(
      { name: "create-pay-token", arguments: { amount: TEST_AMOUNT, sellerServiceId: sid } },
      CallToolResultSchema,
    )
    if (tok.isError) {
      console.log(`   ✗ create-pay-token failed: ${text(tok)}`)
    } else {
      const jwt = text(tok).match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0]
      console.log(`   ✓ Token minted${jwt ? ` (${jwt.slice(0, 24)}…)` : ""}`)
      console.log(`\n   → Set SELLER_SERVICE_ID = "${sid}" in merchant.js (or use a search hint that matches it).`)
    }
  }

  await client.close()
}

main().catch((err) => {
  console.error("verify-skyfire failed:", err.message ?? err)
  process.exit(1)
})
