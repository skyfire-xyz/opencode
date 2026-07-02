import { expect, mock, beforeEach, afterEach } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect, awaitWithTimeout, pollWithTimeout } from "../lib/effect"

// Tool-call-time KYA consent: unlike kya-consent.test.ts (where the *connect*
// 401s), here the connect succeeds and every *tool call* 401s, which routes
// through the KyaToolHook's onUnauthorized wait. These tests cover the wait's
// prompt exits: decline, mint failure, and abort — none of which should burn
// the full 120s window.
class MockUnauthorizedError extends Error {
  constructor(message?: string) {
    super(message ?? "Unauthorized")
    this.name = "UnauthorizedError"
  }
}

void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    constructor(_url: URL, _options?: unknown) {}
    async start() {}
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
    async callTool() {
      throw new MockUnauthorizedError()
    }
    async close() {}
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: MockUnauthorizedError,
}))

// detectKyaSupport talks to the network via global fetch. Route the RFC 9728 +
// RFC 8414 discovery to a server that advertises the KYA grant profile.
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

// Connect the mocked server and return its converted AI SDK tool. Every
// callTool on it 401s, so executing it enters the KYA consent wait.
const setupTool = MCP.Service.use((mcp) =>
  Effect.gen(function* () {
    yield* mcp.connect("kya-server")
    const status = yield* mcp.status()
    expect(status["kya-server"]?.status).toBe("connected")
    const tools = yield* mcp.tools()
    const tool = tools["kya-server_test_tool"]
    expect(tool).toBeDefined()
    return tool!
  }),
)

type GateResult = { isError?: boolean; content?: Array<{ type: string; text: string }> }

const execute = (tool: { execute?: unknown }, abortSignal?: AbortSignal) =>
  (tool.execute as (args: unknown, options: unknown) => Promise<GateResult>)(
    {},
    { toolCallId: "t1", messages: [], abortSignal },
  )

// Poll kyaDecline until a waiter is registered and consumed. Doubles as the
// decline action itself: the first poll to land after registration resolves it.
const declineWhenWaiting = MCP.Service.use((mcp) =>
  pollWithTimeout(
    Effect.map(mcp.kyaDecline("kya-server"), (r) => (r.resolved ? true : undefined)),
    "KYA waiter was never registered",
    "10 seconds",
  ),
)

mcpTest.instance(
  "declining short-circuits the waiting tool call with a decline gate",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const tool = yield* setupTool
      const started = Date.now()
      const pending = execute(tool)
      yield* declineWhenWaiting
      const result = yield* awaitWithTimeout(
        Effect.promise(() => pending),
        "tool call did not settle after decline",
        "5 seconds",
      )
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(result.isError).toBe(true)
      expect(result.content?.[0]?.text).toContain("declined")
      // Registry cleaned: nothing left to decline.
      expect((yield* mcp.kyaDecline("kya-server")).resolved).toBe(false)
    }),
  { config: kyaConfig },
)

mcpTest.instance(
  "a failed mint (kyaAuthorize with no issuer) short-circuits the wait with the real error",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const tool = yield* setupTool
      const pending = execute(tool)
      let settled: GateResult | undefined
      void pending.then((r) => (settled = r))
      // No issuer is configured, so kyaAuthorize fails fast — and must resolve
      // the waiter with that error instead of letting it time out. Keep
      // authorizing until the tool call settles (the waiter may not be
      // registered yet on the first attempt).
      const result = yield* pollWithTimeout(
        Effect.gen(function* () {
          if (settled) return settled
          const res = yield* mcp.kyaAuthorize("kya-server")
          expect(res.status).toBe("failed")
          return undefined
        }),
        "tool call never settled after mint failures",
        "15 seconds",
      )
      expect(result.isError).toBe(true)
      expect(result.content?.[0]?.text).toContain("failed")
    }),
  { config: kyaConfig },
)

mcpTest.instance(
  "aborting the turn exits the consent wait immediately",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const bus = yield* Bus.Service
      const tool = yield* setupTool
      // The consent event fires right before the wait starts; abort after it.
      // waitForKyaConsent checks aborted at registration, so this can't race.
      let sawConsentEvent: () => void
      const consentEvent = new Promise<void>((resolve) => (sawConsentEvent = resolve))
      const unsubscribe = yield* bus.subscribeCallback(MCP.KyaConsentRequired, () => sawConsentEvent())
      const controller = new AbortController()
      const pending = execute(tool, controller.signal)
      yield* awaitWithTimeout(
        Effect.promise(() => consentEvent),
        "consent event never published",
        "10 seconds",
      )
      const started = Date.now()
      controller.abort()
      const error = yield* awaitWithTimeout(
        Effect.promise(() => pending.then(() => undefined).catch((e: Error) => e)),
        "tool call did not settle after abort",
        "5 seconds",
      )
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(error?.name).toBe("AbortError")
      // Abort deregistered the waiter — nothing left to decline.
      expect((yield* mcp.kyaDecline("kya-server")).resolved).toBe(false)
      unsubscribe()
    }),
  { config: kyaConfig },
)

mcpTest.instance(
  "a pre-aborted signal rejects before the consent dialog is ever raised",
  () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const tool = yield* setupTool
      let published = false
      const unsubscribe = yield* bus.subscribeCallback(MCP.KyaConsentRequired, () => (published = true))
      const controller = new AbortController()
      controller.abort()
      const error = yield* awaitWithTimeout(
        Effect.promise(() =>
          execute(tool, controller.signal)
            .then(() => undefined)
            .catch((e: Error) => e),
        ),
        "tool call did not settle for pre-aborted signal",
        "5 seconds",
      )
      expect(error?.name).toBe("AbortError")
      // Give any stray publish a beat to surface, then assert none happened.
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 100)))
      expect(published).toBe(false)
      unsubscribe()
    }),
  { config: kyaConfig },
)

mcpTest.instance(
  "declining resolves concurrent waiters for the server",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const tool = yield* setupTool
      const first = execute(tool)
      const second = execute(tool)
      let settled: GateResult[] | undefined
      void Promise.all([first, second]).then((r) => (settled = r))
      // Keep declining until both calls settle: each decline resolves every
      // waiter registered at that moment (the Set), so this loop also covers
      // the race where the second call registers after the first decline.
      const results = yield* pollWithTimeout(
        Effect.gen(function* () {
          if (settled) return settled
          yield* mcp.kyaDecline("kya-server")
          return undefined
        }),
        "tool calls never settled after declines",
        "15 seconds",
      )
      for (const result of results) {
        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain("declined")
      }
    }),
  { config: kyaConfig },
)
