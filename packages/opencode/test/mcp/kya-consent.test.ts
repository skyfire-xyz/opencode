import { expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { MCP } from "../../src/mcp/index"

// detectKyaSupport / trySilentKya talk to the network via global fetch.
// Route the RFC 9728 + RFC 8414 discovery calls to a server that advertises
// the Skyfire KYA grant profile.
const realFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input))
    const method = init?.method ?? "GET"
    // Unauthenticated probe (POST initialize): answer non-401 so the probe
    // falls back to the default well-known protected-resource location.
    if (url === "https://kya.example.com/mcp" && method === "POST") {
      return new Response("{}", { status: 200 })
    }
    if (url.endsWith("/.well-known/oauth-protected-resource")) {
      return new Response(
        JSON.stringify({ authorization_servers: ["https://as.example.com"], seller_service_id: "svc-1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    if (url.includes("/.well-known/oauth-authorization-server")) {
      return new Response(
        JSON.stringify({
          authorization_grant_profiles_supported: ["urn:ietf:params:oauth:grant-profile:kya"],
          token_endpoint: "https://as.example.com/token",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const mcpTest = testEffect(MCP.defaultLayer)
const kyaConfig = { mcp: { "kya-server": { type: "remote" as const, url: "https://kya.example.com/mcp" } } }

mcpTest.instance(
  "connect() gates a KYA server on consent and does not mint",
  () =>
    MCP.Service.use((mcp) =>
      Effect.gen(function* () {
        yield* mcp.connect("kya-server")
        const status = yield* mcp.status()
        expect(status["kya-server"]?.status).toBe("needs_kya_consent")
      }),
    ),
  { config: kyaConfig },
)

mcpTest.instance(
  "confirmKya() proceeds past the gate and mints (fails clearly when no issuer is configured)",
  () =>
    MCP.Service.use((mcp) =>
      Effect.gen(function* () {
        yield* mcp.confirmKya("kya-server")
        const status = yield* mcp.status()
        const entry = status["kya-server"]
        expect(entry?.status).toBe("failed")
        if (entry?.status === "failed") expect(entry.error).toContain("issuer")
      }),
    ),
  { config: kyaConfig },
)
