import { expect, mock, beforeEach, afterEach } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

// Mock UnauthorizedError to match the SDK's class (instanceof checks in connectRemote).
class MockUnauthorizedError extends Error {
  constructor(message?: string) {
    super(message ?? "Unauthorized")
    this.name = "UnauthorizedError"
  }
}

// The merchant connection 401s, which is what triggers KYA detection in connectRemote.
void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    constructor(_url: URL, _options?: unknown) {}
    async start() {
      throw new MockUnauthorizedError()
    }
    async finishAuth(_code: string) {}
    async close() {}
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(_url: URL, _options?: unknown) {}
    async start() {
      throw new Error("Mock SSE transport cannot connect")
    }
    async close() {}
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(transport: { start: () => Promise<void> }) {
      await transport.start()
    }
    setNotificationHandler() {}
    async listTools() {
      return { tools: [{ name: "test_tool", inputSchema: { type: "object", properties: {} } }] }
    }
    async close() {}
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: MockUnauthorizedError,
}))

// KYA detection (detectKyaSupport) talks to the network via global fetch. Route the
// RFC 9728 + RFC 8414 discovery to a server that advertises the KYA grant profile.
const realFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input))
    const method = init?.method ?? "GET"
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

const { MCP } = await import("../../src/mcp/index")
const { Bus } = await import("../../src/bus")
const { Config } = await import("../../src/config/config")
const { McpAuth } = await import("../../src/mcp/auth")
const { AppFileSystem } = await import("@opencode-ai/core/filesystem")
const { CrossSpawnSpawner } = await import("@opencode-ai/core/cross-spawn-spawner")

const mcpTest = testEffect(
  Layer.mergeAll(
    MCP.layer.pipe(
      Layer.provide(McpAuth.defaultLayer),
      Layer.provideMerge(Bus.layer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(CrossSpawnSpawner.defaultLayer),
      Layer.provide(AppFileSystem.defaultLayer),
    ),
    McpAuth.defaultLayer,
  ),
)

const kyaConfig = { mcp: { "kya-server": { type: "remote" as const, url: "https://kya.example.com/mcp" } } }

mcpTest.instance(
  "connect() without consent gates a KYA server (needs_kya_consent) and does not mint",
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
  "connect({ kyaConsent: true }) tries KYA first, then falls back to default OAuth (needs_auth) when no issuer is configured",
  () =>
    MCP.Service.use((mcp) =>
      Effect.gen(function* () {
        yield* mcp.connect("kya-server", { kyaConsent: true })
        const status = yield* mcp.status()
        // KYA is advertised and consent was given, but no issuer is configured so minting
        // can't complete. Rather than failing, it falls back to opencode's default OAuth,
        // which on the auto-connect path surfaces as needs_auth (run `opencode mcp auth`).
        expect(status["kya-server"]?.status).toBe("needs_auth")
      }),
    ),
  { config: kyaConfig },
)
