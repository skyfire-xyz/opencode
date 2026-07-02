import { expect, mock } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect, awaitWithTimeout } from "../lib/effect"

// Service-level pay-consent abort: a merchant tool call trips the gateway's
// payment signal, the consent wait starts (PayConsentRequired published), and
// aborting the turn must finish the wait immediately — removing the pending
// entry so no 120s timer is left orphaned and no token is ever minted.
//
// Unlike pay-consent.test.ts (which drives executeWithGateway directly with a
// stubbed requestPayConsent), this exercises the real consent closure inside
// MCP.tools(), where the abort handling lives.

const issuerCalls: Array<{ name: string }> = []

void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    url: string
    constructor(url: URL, _options?: unknown) {
      this.url = url.toString()
    }
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
    url = ""
    async connect(transport: { url?: string; start: () => Promise<void> }) {
      this.url = transport.url ?? ""
      await transport.start()
    }
    setNotificationHandler() {}
    async listTools() {
      if (this.url.includes("issuer")) {
        return { tools: [{ name: "create-pay-token", inputSchema: { type: "object", properties: {} } }] }
      }
      return { tools: [{ name: "pay", inputSchema: { type: "object", properties: {} } }] }
    }
    async callTool(params: { name: string }) {
      if (this.url.includes("issuer")) {
        issuerCalls.push({ name: params.name })
        return { isError: false, content: [{ type: "text", text: "token: should.never.mint" }] }
      }
      // The merchant always demands payment: settlement types + total in _meta.
      return {
        isError: true,
        content: [{ type: "text", text: "Payment required" }],
        _meta: {
          "payments/settlement/types": ["org.kyapay:pay"],
          "payments/amount/total": 1.25,
          "payments/settlement/currency": "USD",
          "payments/settlement/seller_service_id": "seller-123",
        },
      }
    }
    async close() {}
  },
}))

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

const payConfig = {
  mcp: {
    merchant: { type: "remote" as const, url: "https://merchant.example.com/mcp" },
    issuer: {
      type: "remote" as const,
      url: "https://issuer.example.com/mcp",
      capabilities: { "org.kyapay:pay": { tool: "create-pay-token" } },
    },
  },
}

type ToolResult = { isError?: boolean; content?: Array<{ type: string; text: string }> }

mcpTest.instance(
  "aborting the turn finishes the pay-consent wait immediately and leaves no pending entry",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const bus = yield* Bus.Service
      yield* mcp.connect("merchant")
      yield* mcp.connect("issuer")
      const tools = yield* mcp.tools()
      const tool = tools["merchant_pay"]
      expect(tool).toBeDefined()
      // The issuer declares capabilities, so its tools are hidden from the agent.
      expect(tools["issuer_create-pay-token"]).toBeUndefined()

      let consentId: string | undefined
      let sawEvent: () => void
      const eventSeen = new Promise<void>((resolve) => (sawEvent = resolve))
      const unsubscribe = yield* bus.subscribeCallback(MCP.PayConsentRequired, (evt) => {
        consentId = evt.properties.consentId
        sawEvent()
      })

      const controller = new AbortController()
      const pending = (tool!.execute as (args: unknown, options: unknown) => Promise<ToolResult>)(
        {},
        { toolCallId: "t1", messages: [], abortSignal: controller.signal },
      )
      yield* awaitWithTimeout(
        Effect.promise(() => eventSeen),
        "PayConsentRequired never published",
        "10 seconds",
      )
      expect(consentId).toBeDefined()

      const started = Date.now()
      controller.abort()
      const result = yield* awaitWithTimeout(
        Effect.promise(() => pending),
        "tool call did not settle after abort",
        "5 seconds",
      )
      // The gateway treats the aborted wait as not-approved and mints nothing.
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(result.isError).toBe(true)
      expect(result.content?.[0]?.text).toContain("not approved")
      expect(issuerCalls).toHaveLength(0)

      // Abort removed the pending entry: a late approval finds nothing.
      expect((yield* mcp.payConsent(consentId!, true)).resolved).toBe(false)
      unsubscribe()
    }),
  { config: payConfig },
)
