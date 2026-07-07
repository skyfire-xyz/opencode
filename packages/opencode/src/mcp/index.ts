import { dynamicTool, type Tool, jsonSchema, type JSONSchema7, type ToolExecutionOptions } from "ai"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@/config/config"
import { ConfigMCP } from "../config/mcp"
import * as Log from "@opencode-ai/core/util/log"
import { NamedError } from "@opencode-ai/core/util/error"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { withTimeout } from "@/util/timeout"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { McpOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import open from "open"
import { Effect, Exit, Layer, Option, Context, Schema, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { executeWithGateway, buildCapabilityMap, type CapabilityMap } from "./gateway"
import {
  type KyaIssuer,
  hasKyaCapability,
  kyaIssuerFromConfig,
  extractJwtFromText,
  probeResourceMetadataUrl,
  KYA_GRANT_PROFILE,
  JWT_BEARER_GRANT_TYPE,
} from "./kya"
import { decodeJwt } from "jose"
import { Flag } from "@opencode-ai/core/flag/flag"

const log = Log.create({ service: "mcp" })
const LOCAL_TARGET_PLACEHOLDER_DOMAIN = "mcp-server.com"
const DEFAULT_TIMEOUT = 30_000
// How long a gated tool call waits inline for the user to approve a KYA
// sign-in (and a fresh token to be stored) before giving up and returning a prompt.
const KYA_CONSENT_WAIT_MS = 120_000
const KYA_CONSENT_POLL_MS = 1_500
// How long a payment gateway call waits inline for the user to approve (or
// decline) a charge in the consent dialog before giving up and aborting the mint.
const PAY_CONSENT_WAIT_MS = 120_000

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = BusEvent.define(
  "mcp.tools.changed",
  Schema.Struct({
    server: Schema.String,
  }),
)

export const BrowserOpenFailed = BusEvent.define(
  "mcp.browser.open.failed",
  Schema.Struct({
    mcpName: Schema.String,
    url: Schema.String,
  }),
)

// Emitted when a tool call to a KYA-advertising server returns 401 and the user
// hasn't signed in yet. The UI reacts by prompting the KYA sign-in.
export const KyaConsentRequired = BusEvent.define(
  "mcp.kya.consent.required",
  Schema.Struct({
    name: Schema.String,
  }),
)

// Emitted when the payment gateway has caught a payment signal and is about to
// mint a pay token. The UI reacts by auto-opening a consent dialog showing the
// order total breakdown; approving/declining resolves via MCP.payConsent.
export const PayConsentRequired = BusEvent.define(
  "mcp.pay.consent.required",
  Schema.Struct({
    name: Schema.String,
    consentId: Schema.String,
    total: Schema.Number,
    currency: Schema.String,
    settlementType: Schema.String,
    subTotal: Schema.optional(Schema.Number),
    taxes: Schema.optional(Schema.Number),
    shippingAndHandling: Schema.optional(Schema.Number),
  }),
)

export const Failed = NamedError.create("MCPFailed", {
  name: Schema.String,
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

type MCPClient = Client

const StatusConnected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const StatusFailed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })
const StatusNeedsKyaConsent = Schema.Struct({ status: Schema.Literal("needs_kya_consent") }).annotate({
  identifier: "MCPStatusNeedsKyaConsent",
})
const StatusNotConnected = Schema.Struct({ status: Schema.Literal("not_connected") }).annotate({
  identifier: "MCPStatusNotConnected",
})

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
  StatusNeedsKyaConsent,
  StatusNotConnected,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

// Store transports for OAuth servers to allow finishing auth
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
const pendingOAuthTransports = new Map<string, TransportWithAuth>()

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type McpEntry = NonNullable<Config.Info["mcp"]>[string]

function isMcpConfigured(entry: unknown): entry is ConfigMCP.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")

function remoteURL(key: string, value: string) {
  if (URL.canParse(value)) return new URL(value)
  log.warn("[remoteURL] invalid remote mcp url", { key })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

function authorizationGrantProfilesSupported(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return []
  const obj = metadata as Record<string, unknown>
  const arr = obj["authorization_grant_profiles_supported"]
  if (!Array.isArray(arr)) return []
  return arr
    .filter((v): v is string => typeof v === "string")
    .flatMap((value) => {
      if (value === KYA_GRANT_PROFILE) return ["kya", value]
      if (value === "urn:ietf:params:oauth:grant-profile:id-jag") return ["id-jag", value]
      return [value]
    })
}

/**
 * Localhost/loopback targets don't exist in the issuer's seller directory, so
 * the issuer rejects them as a `sellerDomainOrUrl`. Substitute a stable placeholder
 * domain for the demo so the issuer mints a valid KYA token against a known seller.
 */
function kyaSellerDomainOrUrl(targetUrl: string): string {
  const host = (() => {
    try {
      return new URL(targetUrl).hostname.toLowerCase()
    } catch {
      return ""
    }
  })()
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
  return isLocal || !host ? LOCAL_TARGET_PLACEHOLDER_DOMAIN : host
}

type KyaSupport = { supportsKya: boolean; authServer: string | undefined; sellerServiceId?: string | undefined }
type KyaMintResult =
  | { minted: true; kyaAdvertised: true }
  | { minted: false; kyaAdvertised: false }
  | { minted: false; kyaAdvertised: true; error: string }

/**
 * Detect (without minting) whether an MCP server advertises the KYA
 * grant profile, following the RFC 9728 → RFC 8414 discovery chain. Used by
 * both the consent gate in `connect()` and `trySilentKya`'s mint preflight.
 */
async function detectKyaSupport(name: string, serverUrl: string): Promise<KyaSupport> {
  // B1–B2: probe the MCP endpoint and read the RFC 9728 resource_metadata
  // pointer from the 401, falling back to the default well-known location.
  const resourceOrigin = new URL(serverUrl).origin
  const resourceMetadataUrl =
    (await probeResourceMetadataUrl(serverUrl)) ??
    new URL("/.well-known/oauth-protected-resource", resourceOrigin).toString()
  log.info("[detectKyaSupport] fetching protected resource metadata", { name, resourceMetadataUrl })
  const protectedRes = await fetch(resourceMetadataUrl, { headers: { accept: "application/json" } })
  if (!protectedRes.ok) return { supportsKya: false, authServer: undefined }

  const protectedJson = (await protectedRes.json()) as any
  // A protected resource may advertise its own seller identity so the
  // KYA token is minted for the right seller without an env override.
  const sellerServiceId =
    typeof protectedJson?.seller_service_id === "string" ? (protectedJson.seller_service_id as string) : undefined
  const authServers =
    Array.isArray(protectedJson?.authorization_servers) &&
    protectedJson.authorization_servers.every((x: any) => typeof x === "string")
      ? (protectedJson.authorization_servers as string[])
      : []
  const authServer = authServers[0]
  if (!authServer) return { supportsKya: false, authServer: undefined, sellerServiceId }

  log.info("[detectKyaSupport] fetching AS metadata", { name, authServer })
  const asMetadataRes = await fetch(new URL("/.well-known/oauth-authorization-server", authServer), {
    headers: { accept: "application/json" },
  })
  const asJson = asMetadataRes.ok
    ? await asMetadataRes.json()
    : await fetch(new URL("/.well-known/openid-configuration", authServer), {
        headers: { accept: "application/json" },
      }).then((r) => (r.ok ? r.json() : undefined))

  const profiles = authorizationGrantProfilesSupported(asJson)
  log.info("[detectKyaSupport] AS grant profiles", {
    name,
    authServer,
    supportsKya: profiles.includes("kya"),
    profiles: profiles.slice(0, 10),
  })
  return { supportsKya: profiles.includes("kya"), authServer, sellerServiceId }
}

function trySilentKya(args: {
  name: string
  serverUrl: string
  auth: McpAuth.Interface
  issuer: KyaIssuer | undefined
  /**
   * Optional override. When set, OpenCode passes this as `sellerServiceId` to
   * the configured KYA issuer tool. When unset, the seller is derived
   * from the target MCP URL and sent as `sellerDomainOrUrl` instead.
   */
  sellerServiceId?: string | undefined
}) {
  // Tracks whether we passed the `supportsKya` gate below. Discovery and the
  // oauth-metadata fetch recover internally (their own catch handlers), so any
  // error that reaches the outer Effect.catch necessarily occurs *after* KYA was
  // confirmed advertised — issuer connect, KYA tool call, or token exchange.
  // Reporting kyaAdvertised:true in that case prevents a genuine KYA failure from
  // silently degrading to interactive OAuth.
  let advertised = false
  return Effect.gen(function* () {
    log.info("[trySilentKya] KYA auth flow BEGIN", {
      name: args.name,
      url: args.serverUrl,
      hasIssuer: !!args.issuer,
    })

    const kyaSupport = yield* Effect.tryPromise({
      try: () => detectKyaSupport(args.name, args.serverUrl),
      catch: () => ({ supportsKya: false, authServer: undefined }) satisfies KyaSupport,
    })

    if (!kyaSupport.supportsKya) {
      log.info("[trySilentKya] KYA not advertised", { name: args.name })
      return { minted: false, kyaAdvertised: false } satisfies KyaMintResult
    }
    advertised = true

    // Seller selector priority: explicit env override > seller advertised by the
    // protected resource > placeholder domain derived from the target URL.
    const resolvedSellerServiceId = args.sellerServiceId ?? kyaSupport.sellerServiceId
    const sellerArg: { sellerServiceId: string } | { sellerDomainOrUrl: string } = resolvedSellerServiceId
      ? { sellerServiceId: resolvedSellerServiceId }
      : { sellerDomainOrUrl: kyaSellerDomainOrUrl(args.serverUrl) }
    log.info("[trySilentKya] resolved seller selector", {
      name: args.name,
      sellerSelector: "sellerServiceId" in sellerArg ? "sellerServiceId" : "sellerDomainOrUrl",
      sellerValue: "sellerServiceId" in sellerArg ? sellerArg.sellerServiceId : sellerArg.sellerDomainOrUrl,
    })

    if (!args.issuer) {
      return {
        minted: false,
        kyaAdvertised: true,
        error:
          'KYA supported but no issuer configured. Add a remote MCP server with capabilities: { "org.kyapay:kya": { "tool": "create-kya-token" } }.',
      } satisfies KyaMintResult
    }
    const issuer = args.issuer

    log.info("[trySilentKya] connecting to issuer", {
      name: args.name,
      issuer: issuer.name,
      issuerUrl: issuer.config.url,
      issuerTool: issuer.tool,
      hasHeaders: !!issuer.config.headers && Object.keys(issuer.config.headers).length > 0,
    })

    const issuerTransport = new StreamableHTTPClientTransport(new URL(issuer.config.url), {
      requestInit: { headers: issuer.config.headers ?? {} },
    })

    const issuerClient = new Client({ name: "opencode", version: InstallationVersion })
    yield* Effect.tryPromise({
      try: () => issuerClient.connect(issuerTransport),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    })

    log.info("[trySilentKya] calling issuer KYA tool", {
      name: args.name,
      issuer: issuer.name,
      issuerUrl: issuer.config.url,
      issuerTool: issuer.tool,
      sellerSelector: "sellerServiceId" in sellerArg ? "sellerServiceId" : "sellerDomainOrUrl",
    })

    const toolResult = yield* Effect.tryPromise({
      try: () => issuerClient.callTool({ name: issuer.tool, arguments: sellerArg }),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    }).pipe(Effect.ensuring(Effect.tryPromise(() => issuerClient.close()).pipe(Effect.ignore)))

    const text = Array.isArray((toolResult as any).content)
      ? (toolResult as any).content.map((c: any) => c.text ?? "").join("\n")
      : String((toolResult as any).content ?? "")

    log.info("[trySilentKya] issuer tool response", {
      name: args.name,
      textPrefix: text.slice(0, 200),
      length: text.length,
    })

    const assertion = extractJwtFromText(text)
    if (!assertion) {
      return {
        minted: false,
        kyaAdvertised: true,
        error: "Could not extract JWT assertion from issuer tool output",
      } satisfies KyaMintResult
    }

    log.info("[trySilentKya] extracted assertion", {
      name: args.name,
      assertionPrefix: assertion.slice(0, 16),
      assertionLength: assertion.length,
    })

    const oauthMetadata = yield* Effect.tryPromise({
      try: async () => {
        const authServer = kyaSupport.authServer
        if (!authServer) return undefined
        const asMetadataRes = await fetch(new URL("/.well-known/oauth-authorization-server", authServer), {
          headers: { accept: "application/json" },
        })
        return asMetadataRes.ok ? ((await asMetadataRes.json()) as any) : undefined
      },
      catch: () => undefined,
    })

    const tokenEndpoint =
      oauthMetadata && typeof oauthMetadata === "object" && typeof (oauthMetadata as any).token_endpoint === "string"
        ? ((oauthMetadata as any).token_endpoint as string)
        : undefined
    if (!tokenEndpoint) {
      return {
        minted: false,
        kyaAdvertised: true,
        error: "Auth server metadata missing token_endpoint",
      } satisfies KyaMintResult
    }

    log.info("[trySilentKya] exchanging assertion for access token", { name: args.name, tokenEndpoint })

    const form = new URLSearchParams({
      grant_type: JWT_BEARER_GRANT_TYPE,
      assertion,
    })

    const tokenJson = yield* Effect.tryPromise({
      try: async () => {
        const res = await fetch(tokenEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form,
        })
        if (!res.ok) throw new Error(`OAuth token exchange failed (${res.status}): ${await res.text()}`)
        return (await res.json()) as any
      },
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    })

    const accessToken = tokenJson && typeof tokenJson.access_token === "string" ? tokenJson.access_token : undefined
    if (!accessToken) {
      return {
        minted: false,
        kyaAdvertised: true,
        error: "Token exchange response missing access_token",
      } satisfies KyaMintResult
    }

    let expiresAt: number | undefined =
      typeof tokenJson.expires_in === "number" ? Date.now() / 1000 + tokenJson.expires_in : undefined
    if (expiresAt === undefined) {
      try {
        const exp = decodeJwt(accessToken).exp
        if (typeof exp === "number") expiresAt = exp
      } catch {
        // Access token isn't a readable JWT — leave expiry unset.
      }
    }

    log.info("[trySilentKya] token exchange success", {
      name: args.name,
      accessTokenPrefix: accessToken.slice(0, 12),
      accessTokenLength: accessToken.length,
      expiresAt,
    })

    yield* args.auth.updateTokens(
      args.name,
      {
        accessToken,
        refreshToken: undefined,
        expiresAt,
        scope: typeof tokenJson.scope === "string" ? tokenJson.scope : undefined,
      },
      new URL(args.serverUrl).origin,
    )
    log.info("[trySilentKya] stored access token", {
      name: args.name,
      tokenKey: new URL(args.serverUrl).origin,
    })

    return { minted: true, kyaAdvertised: true } satisfies KyaMintResult
  }).pipe(
    Effect.catch((e) => {
      const error = e instanceof Error ? e.message : String(e)
      // If KYA was advertised, a thrown failure (issuer connect / tool call /
      // token exchange) must surface as a KYA failure rather than fall through
      // to interactive OAuth. Only pre-gate errors report kyaAdvertised:false.
      return Effect.succeed(
        advertised
          ? ({ minted: false, kyaAdvertised: true, error } satisfies KyaMintResult)
          : ({ minted: false, kyaAdvertised: false } satisfies KyaMintResult),
      )
    }),
    Effect.tap((result) =>
      Effect.sync(() => log.info("[trySilentKya] KYA auth flow END", { name: args.name, ...result })),
    ),
  )
}

function listTools(key: string, client: MCPClient, timeout: number) {
  return Effect.tryPromise({
    try: () => client.listTools(undefined, { timeout }),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(
    Effect.map((result) => result.tools),
    Effect.catch((error) => {
      if (!isOutputSchemaValidationError(error)) return Effect.fail(error)

      log.warn("[listTools] failed to validate MCP tool output schemas, retrying without output schema validation", {
        key,
        error,
      })
      return Effect.tryPromise({
        try: () =>
          client.request({ method: "tools/list" }, TolerantListToolsResultSchema, {
            timeout,
          }),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.map((result) =>
          result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        ),
      )
    }),
  )
}

// A tool-call 401 arrives either as the SDK's UnauthorizedError or a
// StreamableHTTPError carrying code 401.
function isUnauthorizedError(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true
  if (error && typeof error === "object") {
    const e = error as { name?: string; code?: number; message?: string }
    if (e.name === "UnauthorizedError") return true
    if (e.code === 401) return true
    if (typeof e.message === "string" && /\b401\b|unauthorized/i.test(e.message)) return true
  }
  return false
}

// Rejection used when a consent wait is cut short by the AI SDK abort signal
// (turn cancelled). Mirrors ripgrep.ts's aborted(): prefer the signal's own
// reason so the SDK's cancellation handling sees its original error.
function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const err = new Error("Tool call aborted")
  err.name = "AbortError"
  return err
}

// Order breakdown passed to the pay-consent gate.
type PayConsentInfo = {
  total: number
  currency: string
  subTotal?: number
  taxes?: number
  shippingAndHandling?: number
  settlementType: string
  settlementTypes: string[]
}

// How a pending KYA consent wait is resolved by the service (via the UI's
// kya-authorize call): minted (approve succeeded), failed (mint errored),
// declined (user said no / dismissed the dialog).
type KyaConsentResolution = { type: "minted" } | { type: "failed"; error: string } | { type: "declined" }
// Waiter-local terminal states on top of the above.
type KyaWaitOutcome = KyaConsentResolution | { type: "timeout" } | { type: "aborted" }

// Hook invoked when a tool call 401s. It decides the outcome:
//   - retry: a KYA sign-in was approved and a fresh token stored → retry inline
//   - gate: sign-in needed but not approved (declined/failed/timed out) → return a prompt result
//   - passthrough: unrelated 401 (not a KYA server) → rethrow unchanged
// Throws when the wait is aborted (turn cancelled) so the call exits promptly.
type KyaToolHook = {
  onUnauthorized: (
    abortSignal?: AbortSignal,
  ) => Promise<{ action: "retry" } | { action: "gate"; text: string } | { action: "passthrough" }>
}

// Convert MCP tool definition to AI SDK Tool type
function convertMcpTool(
  mcpTool: MCPToolDef,
  client: MCPClient,
  timeout?: number,
  gateway?: { clients: Record<string, MCPClient>; capabilityMap: CapabilityMap },
  kya?: KyaToolHook,
  requestPayConsent?: (info: PayConsentInfo, abortSignal?: AbortSignal) => Promise<boolean>,
): Tool {
  const inputSchema = mcpTool.inputSchema

  // Spread first, then override type to ensure it's always "object"
  const schema: JSONSchema7 = {
    ...(inputSchema as JSONSchema7),
    type: "object",
    properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schema),
    execute: async (args: unknown, options?: ToolExecutionOptions) => {
      // Bind the turn's abort signal here so executeWithGateway's signature
      // stays unchanged — the signal only feeds the consent waits, not the
      // MCP request itself.
      const abortSignal = options?.abortSignal
      const payConsent = requestPayConsent ? (info: PayConsentInfo) => requestPayConsent(info, abortSignal) : undefined
      const run = () =>
        gateway
          ? executeWithGateway({
              toolName: mcpTool.name,
              args: (args || {}) as Record<string, unknown>,
              client,
              clients: gateway.clients,
              capabilityMap: gateway.capabilityMap,
              timeout,
              requestPayConsent: payConsent,
            })
          : client.callTool(
              { name: mcpTool.name, arguments: (args || {}) as Record<string, unknown> },
              CallToolResultSchema,
              { resetTimeoutOnProgress: true, timeout },
            )
      log.info("[convertMcpTool] tool call REQUEST", { tool: mcpTool.name, args })
      try {
        const result = await run()
        log.info("[convertMcpTool] tool call RESPONSE", { tool: mcpTool.name, isError: !!(result as any)?.isError })
        return result
      } catch (error) {
        // A 401 from a KYA-advertising server is recoverable: the hook prompts the
        // user to sign in and waits; when approved (a fresh token is stored) we retry
        // this same call inline so it completes in one go. Everything else rethrows.
        if (!kya || !isUnauthorizedError(error)) throw error
        const outcome = await kya.onUnauthorized(abortSignal)
        if (outcome.action === "retry") {
          if (abortSignal?.aborted) throw abortError(abortSignal)
          try {
            return await run()
          } catch (retryError) {
            // Sign-in happened but the token still didn't unlock the tool (e.g. the
            // issuer's assertion was rejected). Surface a clear result, don't loop.
            if (isUnauthorizedError(retryError))
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "The KYA sign-in completed but the tool is still unauthorized (the token was rejected). Please check the server's KYA issuer configuration.",
                  },
                ],
                isError: true,
              }
            throw retryError
          }
        }
        if (outcome.action === "gate")
          return { content: [{ type: "text" as const, text: outcome.text }], isError: true }
        throw error
      }
    },
  })
}

function defs(key: string, client: MCPClient, timeout?: number) {
  return listTools(key, client, timeout ?? DEFAULT_TIMEOUT).pipe(
    Effect.catch((err) => {
      log.error("[defs] failed to get tools from client", { key, error: err })
      return Effect.succeed(undefined)
    }),
  )
}

function fetchFromClient<T extends { name: string }>(
  clientName: string,
  client: Client,
  listFn: (c: Client) => Promise<T[]>,
  label: string,
) {
  return Effect.tryPromise({
    try: () => listFn(client),
    catch: (e: any) => {
      log.error(`[fetchFromClient] failed to get ${label}`, { clientName, error: e.message })
      return e
    },
  }).pipe(
    Effect.map((items) => {
      const out: Record<string, T & { client: string }> = {}
      const sanitizedClient = sanitize(clientName)
      for (const item of items) {
        out[sanitizedClient + ":" + sanitize(item.name)] = { ...item, client: clientName }
      }
      return out
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
}

interface AuthResult {
  authorizationUrl: string
  oauthState: string
  client?: MCPClient
}

// --- Effect Service ---

interface State {
  config: Record<string, ConfigMCP.Info>
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly tools: () => Effect.Effect<Record<string, Tool>>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: () => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly add: (name: string, mcp: ConfigMCP.Info) => Effect.Effect<{ status: Record<string, Status> | Status }>
  readonly connect: (name: string, opts?: { kyaConsent?: boolean }) => Effect.Effect<void, NotFoundError>
  readonly kyaAuthorize: (
    name: string,
  ) => Effect.Effect<{ status: "connected" | "failed"; error?: string }, NotFoundError>
  readonly kyaDecline: (name: string) => Effect.Effect<{ resolved: boolean }, NotFoundError>
  readonly payConsent: (consentId: string, approved: boolean) => Effect.Effect<{ resolved: boolean }>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (
    mcpName: string,
  ) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, NotFoundError>
  readonly authenticate: (mcpName: string) => Effect.Effect<Status, NotFoundError>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status, NotFoundError>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean, NotFoundError>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const bus = yield* Bus.Service

    // Pending payment-consent prompts keyed by consentId. The gateway registers
    // a resolver before publishing PayConsentRequired and waits on it; the UI's
    // payConsent call resolves it. Lives in the (per-instance) service closure
    // so both the tool-execute hook and the payConsent handler share it, and
    // workspace routing keeps the HTTP call on this same instance.
    const pendingPayConsents = new Map<string, (approved: boolean) => void>()

    // Pending KYA consent waiters keyed by SERVER NAME (KyaConsentRequired
    // carries only {name}); a Set because several gated tool calls for the same
    // server can wait concurrently and must all resolve together. kyaAuthorize
    // resolves them on both mint success and failure; kyaDecline resolves them
    // as declined. Same instance-scoped lifetime and workspace-routing guarantee
    // as pendingPayConsents.
    const pendingKyaConsents = new Map<string, Set<(resolution: KyaConsentResolution) => void>>()

    // Resolve every pending waiter for `name`. Returns whether any were pending.
    const resolveKyaWaiters = (name: string, resolution: KyaConsentResolution) => {
      const waiters = pendingKyaConsents.get(name)
      if (!waiters || waiters.size === 0) return false
      for (const resolve of [...waiters]) resolve(resolution) // copy: settle() self-removes
      return true
    }

    // Race for a gated tool call's KYA consent: resolver (same-instance
    // approve/decline/failure) | fresh-token poll (fallback: a mint from another
    // instance/process lands in the global McpAuth file) | abort | deadline.
    // Every exit path runs settle() exactly once, which clears both timers,
    // deregisters the resolver, and removes the abort listener — nothing
    // outlives the wait.
    const waitForKyaConsent = (input: {
      name: string
      before: string | undefined
      getToken: () => Promise<string | undefined>
      abortSignal?: AbortSignal
    }): Promise<KyaWaitOutcome> =>
      new Promise((resolve) => {
        let done = false
        let pollTimer: ReturnType<typeof setTimeout> | undefined
        const waiters = pendingKyaConsents.get(input.name) ?? new Set()
        pendingKyaConsents.set(input.name, waiters)
        const settle = (outcome: KyaWaitOutcome) => {
          if (done) return
          done = true
          clearTimeout(deadlineTimer)
          if (pollTimer !== undefined) clearTimeout(pollTimer)
          waiters.delete(onResolution)
          if (waiters.size === 0) pendingKyaConsents.delete(input.name)
          input.abortSignal?.removeEventListener("abort", onAbort)
          resolve(outcome)
        }
        const onResolution = (resolution: KyaConsentResolution) => settle(resolution)
        const onAbort = () => settle({ type: "aborted" })
        const deadlineTimer = setTimeout(() => settle({ type: "timeout" }), KYA_CONSENT_WAIT_MS)
        waiters.add(onResolution)
        if (input.abortSignal?.aborted) return settle({ type: "aborted" })
        input.abortSignal?.addEventListener("abort", onAbort, { once: true })
        // Self-scheduling timeout (not setInterval) so a slow getToken never
        // overlaps; the `done` re-check discards a late poll result.
        const poll = async () => {
          if (done) return
          const token = await input.getToken().catch(() => undefined)
          if (done) return
          if (token && token !== input.before) return settle({ type: "minted" })
          pollTimer = setTimeout(poll, KYA_CONSENT_POLL_MS)
        }
        pollTimer = setTimeout(poll, KYA_CONSENT_POLL_MS)
      })

    type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

    /**
     * Connect a client via the given transport with resource safety:
     * on failure the transport is closed; on success the caller owns it.
     */
    const connectTransport = (transport: Transport, timeout: number) =>
      Effect.acquireUseRelease(
        Effect.succeed(transport),
        (t) =>
          Effect.tryPromise({
            try: () => {
              const client = new Client({ name: "opencode", version: InstallationVersion })
              return withTimeout(client.connect(t), timeout).then(() => client)
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
        (t, exit) => (Exit.isFailure(exit) ? Effect.tryPromise(() => t.close()).pipe(Effect.ignore) : Effect.void),
      )

    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "remote" },
      consented: boolean,
    ) {
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      const url = remoteURL(key, mcp.url)
      if (!url) {
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: `Invalid MCP URL for "${key}"` },
        }
      }
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            callbackPort: oauthConfig?.callbackPort,
            redirectUri: oauthConfig?.redirectUri,
          },
          {
            // Fires only for non-KYA servers: the provider suppresses DCR + redirect
            // for KYA servers, but ordinary OAuth servers still reach this callback.
            onRedirect: async (url) => {
              log.info("[connectRemote] oauth redirect requested", { key, url: url.toString() })
            },
          },
          auth,
          // allowInteractive = false: on the auto-connect / live transport, suppress
          // interactive OAuth (DCR + browser) *only for KYA servers* so a 401 surfaces
          // to our KYA handlers. Non-KYA servers still get standard interactive OAuth.
          false,
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(url, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(url, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      let lastStatus: Status | undefined
      let kyaRetried = false
      // A server that answered the StreamableHTTP attempt with a 401 clearly
      // speaks HTTP and just needs auth — never fall back to SSE (which would
      // 404 on such servers and mask the real auth/KYA failure).
      let stopTransportFallback = false

      // A transport can't be reused after a failed connect, so build a fresh
      // StreamableHTTP transport for the post-KYA retry. The authProvider's
      // tokens() will now return the access token stored by trySilentKya.
      const freshStreamable = () =>
        new StreamableHTTPClientTransport(url, {
          authProvider,
          requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
        })

      for (const { name, transport } of transports) {
        const result = yield* connectTransport(transport, connectTimeout).pipe(
          Effect.map((client) => ({ client, transportName: name })),
          Effect.catch((error) =>
            Effect.gen(function* () {
              const lastError = error instanceof Error ? error : new Error(String(error))
              const isAuthError =
                error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

              if (isAuthError) {
                log.info("[connectRemote] mcp server requires authentication", { key, transport: name })
                stopTransportFallback = true

                if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                  lastStatus = {
                    status: "needs_client_registration" as const,
                    error: "Server does not support dynamic client registration. Please provide clientId in config.",
                  }
                  yield* bus
                    .publish(TuiEvent.ToastShow, {
                      title: "MCP Authentication Required",
                      message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                      variant: "warning",
                      duration: 8000,
                    })
                    .pipe(Effect.ignore)
                  return undefined
                }

                // An auth-required server may advertise the KYA grant profile.
                // Detect it from the 401 — never for the issuer itself, for
                // header/api-key-authenticated servers, or when OAuth is disabled.
                if (
                  name === "StreamableHTTP" &&
                  !kyaRetried &&
                  !hasKyaCapability(mcp) &&
                  mcp.oauth !== false &&
                  !(mcp.headers && Object.keys(mcp.headers).length > 0)
                ) {
                  const kyaSupport = yield* Effect.tryPromise(() => detectKyaSupport(key, mcp.url)).pipe(
                    Effect.orElseSucceed(() => ({ supportsKya: false, authServer: undefined }) satisfies KyaSupport),
                  )

                  if (kyaSupport.supportsKya) {
                    // Minting a KYA token to access this server requires explicit
                    // "Sign in with KYA" consent. Without it, gate: surface
                    // needs_kya_consent and stop. The retry arrives here with
                    // consented=true once the user confirms in the UI.
                    if (!consented) {
                      log.info("[connectRemote] KYA sign-in available; awaiting user consent", { key })
                      lastStatus = { status: "needs_kya_consent" as const }
                      return undefined
                    }

                    const minted = yield* mintKya(key, mcp.url)
                    if (minted.minted) {
                      // Token stored — retry StreamableHTTP once with a fresh transport.
                      kyaRetried = true
                      log.info("[connectRemote] kya mint: stored token, retrying StreamableHTTP connect", { key })
                      return yield* connectTransport(freshStreamable(), connectTimeout).pipe(
                        Effect.map((client) => ({ client, transportName: name })),
                        Effect.catch((retryError) => {
                          const e = retryError instanceof Error ? retryError : new Error(String(retryError))
                          lastStatus = { status: "failed" as const, error: e.message }
                          return Effect.succeed(undefined)
                        }),
                      )
                    }

                    // Consent given but KYA minting couldn't complete (e.g. no issuer
                    // configured, or a mint / token-exchange error). KYA is the priority
                    // when advertised, but it falls back to opencode's default OAuth:
                    // don't return here — let control fall through to the needs_auth path
                    // below, which stores the pending transport and prompts the user to run
                    // `opencode mcp auth <key>` (the interactive DCR + browser flow).
                    log.warn("[connectRemote] KYA minting failed; falling back to default OAuth", {
                      key,
                      error: minted.error ?? "Silent KYA token minting failed",
                    })
                  }
                }

                pendingOAuthTransports.set(key, transport)
                lastStatus = { status: "needs_auth" as const }
                yield* bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires authentication. Run: opencode mcp auth ${key}`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore)
                return undefined
              }

              log.debug("[connectRemote] transport connection failed", {
                key,
                transport: name,
                url: mcp.url,
                error: lastError.message,
              })
              lastStatus = { status: "failed" as const, error: lastError.message }
              return undefined
            }),
          ),
        )
        if (result) {
          log.info("[connectRemote] connected", { key, transport: result.transportName })
          return { client: result.client as MCPClient | undefined, status: { status: "connected" } as Status }
        }
        // If this was an auth error, stop trying other transports
        if (stopTransportFallback) break
        if (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration") break
      }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ?? { status: "failed", error: "Unknown error" }) as Status,
      }
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "local" },
    ) {
      const [cmd, ...args] = mcp.command
      const cwd = yield* InstanceState.directory
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        env: {
          ...process.env,
          ...(cmd === "opencode" ? { BUN_BE_BUN: "1" } : {}),
          ...mcp.environment,
        },
      })
      transport.stderr?.on("data", (chunk: Buffer) => {
        log.info(`[connectLocal] mcp stderr: ${chunk.toString()}`, { key })
      })

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      return yield* connectTransport(transport, connectTimeout).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status } => ({
          client,
          status: { status: "connected" },
        })),
        Effect.catch((error): Effect.Effect<{ client: MCPClient | undefined; status: Status }> => {
          const msg = error instanceof Error ? error.message : String(error)
          log.error("[connectLocal] local mcp startup failed", { key, command: mcp.command, cwd, error: msg })
          return Effect.succeed({ client: undefined, status: { status: "failed", error: msg } })
        }),
      )
    })

    const create = Effect.fn("MCP.create")(function* (key: string, mcp: ConfigMCP.Info, consented = false) {
      if (mcp.enabled === false) {
        log.info("[create] mcp server disabled", { key })
        return DISABLED_RESULT
      }

      log.info("[create] found", { key, type: mcp.type })

      const { client: mcpClient, status } =
        mcp.type === "remote"
          ? yield* connectRemote(key, mcp as ConfigMCP.Info & { type: "remote" }, consented)
          : yield* connectLocal(key, mcp as ConfigMCP.Info & { type: "local" })

      if (!mcpClient) {
        return { status } satisfies CreateResult
      }

      const listed = yield* defs(key, mcpClient, mcp.timeout)
      if (!listed) {
        yield* Effect.tryPromise(() => mcpClient.close()).pipe(Effect.ignore)
        return { status: { status: "failed", error: "Failed to get tools" } } satisfies CreateResult
      }

      log.info("[create] successfully created client", { key, toolCount: listed.length })
      return { mcpClient, status, defs: listed } satisfies CreateResult
    })
    const cfgSvc = yield* Config.Service

    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        while (queue.length > 0) {
          const current = queue.shift()!
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed([] as number[])),
    )

    function watch(s: State, name: string, client: MCPClient, bridge: EffectBridge.Shape, timeout?: number) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        log.info("[watch] tools list changed notification received", { server: name })
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        const listed = await bridge.promise(defs(name, client, timeout))
        if (!listed) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        s.defs[name] = listed
        await bridge.promise(bus.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const s: State = {
          config: {},
          status: {},
          clients: {},
          defs: {},
        }

        // We intentionally don't eagerly connect MCP servers here. Connections
        // (and any KYA auth they trigger) happen on-demand via MCP.connect when
        // the user enables a server in the UI.

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.forEach(
              Object.values(s.clients),
              (client) =>
                Effect.gen(function* () {
                  const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
                  if (typeof pid === "number") {
                    const pids = yield* descendants(pid)
                    for (const dpid of pids) {
                      try {
                        process.kill(dpid, "SIGTERM")
                      } catch {}
                    }
                  }
                  yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
                }),
              { concurrency: "unbounded" },
            )
            pendingOAuthTransports.clear()
          }),
        )

        return s
      }),
    )

    function closeClient(s: State, name: string) {
      const client = s.clients[name]
      delete s.defs[name]
      if (!client) return Effect.void
      return Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
    }

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      timeout?: number,
    ) {
      const bridge = yield* EffectBridge.make()
      yield* closeClient(s, name)
      s.status[name] = { status: "connected" }
      s.clients[name] = client
      s.defs[name] = listed
      watch(s, name, client, bridge, timeout)
      return s.status[name]
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!isMcpConfigured(mcp)) continue
        if (mcp.enabled === false) {
          result[key] = { status: "disabled" }
          continue
        }
        result[key] = s.status[key] ?? { status: "not_connected" }
      }

      for (const key of Object.keys(s.config)) {
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      const s = yield* InstanceState.get(state)
      return s.clients
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (
      name: string,
      mcp: ConfigMCP.Info,
      consented = false,
    ) {
      const s = yield* InstanceState.get(state)
      const result = yield* create(name, mcp, consented)

      s.status[name] = result.status
      if (!result.mcpClient) {
        yield* closeClient(s, name)
        delete s.clients[name]
        return result.status
      }

      return yield* storeClient(s, name, result.mcpClient, result.defs!, mcp.timeout)
    })

    const add = Effect.fn("MCP.add")(function* (name: string, mcp: ConfigMCP.Info) {
      const s = yield* InstanceState.get(state)
      s.config[name] = mcp
      yield* createAndStore(name, mcp)
      return { status: s.status }
    })

    // Resolve the KYA issuer to mint through. Parity with the payment gateway: the
    // issuer must be configured AND enabled (toggled on, hence connected) so its
    // config + API key are validated. Shared by the connect-time 401 path and the
    // tool-call authorize path.
    const resolveEnabledKyaIssuer = Effect.fn("MCP.resolveEnabledKyaIssuer")(function* () {
      const cfg = yield* cfgSvc.get()
      const configuredIssuer = kyaIssuerFromConfig(cfg.mcp as Record<string, ConfigMCP.Info> | undefined)
      const s = yield* InstanceState.get(state)
      const issuerEnabled = !!configuredIssuer && s.status[configuredIssuer.name]?.status === "connected"
      const issuer = issuerEnabled ? configuredIssuer : undefined
      if (!issuer && !Flag.OPENCODE_KYA_INTERACTIVE_FALLBACK) {
        return {
          issuer: undefined,
          error:
            configuredIssuer && !issuerEnabled
              ? `KYA issuer "${configuredIssuer.name}" is configured but not enabled. Enable it (toggle it on) so its config and API key are validated, then retry.`
              : 'KYA supported but no issuer configured. Add a remote MCP server with capabilities: { "org.kyapay:kya": { "tool": "create-kya-token" } }.',
        }
      }
      return { issuer, error: undefined as string | undefined }
    })

    // Mint + exchange + store a KYA access token for `name`. Returns minted:false
    // with a human-readable error on any failure (no issuer, mint/exchange failed).
    const mintKya = Effect.fn("MCP.mintKya")(function* (name: string, serverUrl: string) {
      const { issuer, error } = yield* resolveEnabledKyaIssuer()
      if (error) return { minted: false as const, error }
      const result = yield* trySilentKya({
        name,
        serverUrl,
        auth,
        issuer,
        sellerServiceId: Flag.OPENCODE_KYA_SELLER_SERVICE_ID,
      })
      if (result.minted) return { minted: true as const }
      return {
        minted: false as const,
        error: "error" in result && typeof result.error === "string" ? result.error : "Silent KYA token minting failed",
      }
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string, opts?: { kyaConsent?: boolean }) {
      const mcp = yield* requireMcpConfig(name)
      // KYA detection + consent gating happens in connectRemote at the real 401.
      // `kyaConsent` carries the user's "Sign in with KYA" confirmation:
      // false → gate (needs_kya_consent); true → mint + connect.
      yield* createAndStore(name, { ...mcp, enabled: true }, opts?.kyaConsent ?? false)
    })

    // Mint a KYA token for an already-connected server (the user approved the
    // tool-call sign-in prompt). Unlike connect(), this does NOT reconnect — the
    // live transport reads the stored token on its next request. On success we
    // flip the status back to connected so the previously-gated tools reappear.
    // Mint on user approval. Also resolves any tool calls waiting on this
    // server's consent — on success (mint stored the token, safe to retry
    // immediately) and on failure (gate with the real error instead of letting
    // the wait burn its full window).
    const kyaAuthorize = Effect.fn("MCP.kyaAuthorize")(function* (name: string) {
      const mcp = yield* requireMcpConfig(name)
      if (mcp.type !== "remote") {
        const error = "KYA is only supported for remote MCP servers."
        resolveKyaWaiters(name, { type: "failed", error })
        return { status: "failed" as const, error }
      }
      const minted = yield* mintKya(name, mcp.url)
      if (!minted.minted) {
        const error = minted.error ?? "Silent KYA token minting failed"
        resolveKyaWaiters(name, { type: "failed", error })
        return { status: "failed" as const, error }
      }
      const s = yield* InstanceState.get(state)
      if (s.status[name]?.status !== "connected") s.status[name] = { status: "connected" as const }
      resolveKyaWaiters(name, { type: "minted" })
      return { status: "connected" as const }
    })

    // Resolve pending KYA consent waiters as declined (the user said No or
    // dismissed the sign-in dialog). Returns resolved:false when nothing was
    // waiting (e.g. the wait already timed out, was aborted, or the mint
    // already landed).
    const kyaDecline = Effect.fn("MCP.kyaDecline")(function* (name: string) {
      yield* requireMcpConfig(name)
      const resolved = resolveKyaWaiters(name, { type: "declined" })
      log.info("[kyaDecline] user declined KYA sign-in", { name, resolved })
      return { resolved }
    })

    // Resolve a pending payment-consent prompt (the user clicked Yes/No in the
    // consent dialog). The waiting gateway call unblocks and either mints or
    // aborts. Returns resolved:false when the consentId is unknown (e.g. the
    // prompt already timed out).
    const payConsent = Effect.fn("MCP.payConsent")(function* (consentId: string, approved: boolean) {
      const resolve = pendingPayConsents.get(consentId)
      if (!resolve) {
        log.info("[payConsent] no pending consent for id", { consentId })
        return { resolved: false }
      }
      log.info("[payConsent] resolving pending consent", { consentId, approved })
      resolve(approved)
      return { resolved: true }
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      yield* requireMcpConfig(name)
      const s = yield* InstanceState.get(state)
      yield* closeClient(s, name)
      delete s.clients[name]
      s.status[name] = { status: "disabled" }
    })

    const tools = Effect.fn("MCP.tools")(function* () {
      const result: Record<string, Tool> = {}
      const s = yield* InstanceState.get(state)
      // Lets the detached tool-execute callback publish bus events from async code.
      const bridge = yield* EffectBridge.make()

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const defaultTimeout = cfg.experimental?.mcp_timeout

      const capabilityMap = buildCapabilityMap(config)

      // Servers that declare capabilities are payment-network infrastructure
      // (token issuers). The gateway reaches them directly via s.clients, so
      // their tools must NOT be exposed to the agent — otherwise the LLM could
      // call create-pay-token / find-sellers itself and bypass the gateway.
      const providerServers = new Set(Object.values(capabilityMap).flatMap((entries) => entries.map((e) => e.server)))

      const connectedClients = Object.entries(s.clients).filter(
        ([clientName]) => s.status[clientName]?.status === "connected" && !providerServers.has(clientName),
      )

      yield* Effect.forEach(
        connectedClients,
        ([clientName, client]) =>
          Effect.gen(function* () {
            const mcpConfig = config[clientName]
            const entry = mcpConfig && isMcpConfigured(mcpConfig) ? mcpConfig : s.config[clientName]

            const listed = s.defs[clientName]
            if (!listed) {
              log.warn("[tools] missing cached tools for connected server", { clientName })
              return
            }

            const timeout = entry?.timeout ?? defaultTimeout
            const hasCapabilities = Object.keys(capabilityMap).length > 0
            const gateway = hasCapabilities ? { clients: s.clients, capabilityMap } : undefined

            // For remote servers, gate a tool-call 401 behind a KYA sign-in
            // prompt when (and only when) the server advertises KYA. Detection runs
            // lazily — only on an actual 401, not at list time.
            const remoteUrl = entry && isMcpConfigured(entry) && entry.type === "remote" ? entry.url : undefined
            const kya: KyaToolHook | undefined = remoteUrl
              ? {
                  onUnauthorized: async (abortSignal) => {
                    const support = await detectKyaSupport(clientName, remoteUrl).catch(
                      () => ({ supportsKya: false }) as Awaited<ReturnType<typeof detectKyaSupport>>,
                    )
                    if (!support.supportsKya) return { action: "passthrough" as const }
                    const origin = new URL(remoteUrl).origin
                    // Snapshot the current (rejected/absent) token so we can detect a
                    // *fresh* mint, not a stale one already on disk.
                    const getToken = async () =>
                      (await bridge.promise(auth.getForUrl(clientName, origin)))?.tokens?.accessToken
                    const before = await getToken()
                    // Turn already cancelled — don't raise a ghost dialog.
                    if (abortSignal?.aborted) throw abortError(abortSignal)
                    // Prompt for sign-in via the global bus (the UI auto-opens the
                    // consent dialog). McpAuth is a global file, so kyaAuthorize's mint
                    // from the UI's request is visible to this wait across instances
                    // via the token poll fallback.
                    await bridge.promise(bus.publish(KyaConsentRequired, { name: clientName }).pipe(Effect.ignore))
                    // Wait (in this same tool call) for the outcome so an approval can
                    // retry inline — no second prompt needed. Decline/failure resolve
                    // promptly via the waiter registry; abort exits immediately.
                    const outcome = await waitForKyaConsent({ name: clientName, before, getToken, abortSignal })
                    switch (outcome.type) {
                      case "minted":
                        return { action: "retry" as const }
                      case "aborted":
                        log.info("[kya] consent wait aborted", { name: clientName })
                        throw abortError(abortSignal)
                      case "declined":
                        log.info("[kya] consent declined by user", { name: clientName })
                        return {
                          action: "gate" as const,
                          text: `The user declined the KYA sign-in for "${clientName}". The tool was not run.`,
                        }
                      case "failed":
                        log.info("[kya] sign-in failed while tool call waited", {
                          name: clientName,
                          error: outcome.error,
                        })
                        return {
                          action: "gate" as const,
                          text: `KYA sign-in for "${clientName}" failed: ${outcome.error}`,
                        }
                      case "timeout":
                        log.info("[kya] consent not approved within wait window", { name: clientName })
                        return {
                          action: "gate" as const,
                          text: `KYA sign-in for "${clientName}" wasn't approved in time. Approve the sign-in prompt, then ask me to retry.`,
                        }
                    }
                  },
                }
              : undefined

            // When a gateway is active, gate pay-token minting behind a consent
            // dialog. The gateway calls this once it has caught a payment signal
            // and resolved a provider; we publish the order total and block this
            // tool call until the user approves (or it times out → decline).
            const requestPayConsent = gateway
              ? (info: PayConsentInfo, abortSignal?: AbortSignal) =>
                  new Promise<boolean>((resolve) => {
                    if (abortSignal?.aborted) {
                      log.info("[pay] consent skipped, turn already aborted", { name: clientName })
                      resolve(false)
                      return
                    }
                    const consentId = crypto.randomUUID()
                    let done = false
                    const finish = (approved: boolean) => {
                      if (done) return
                      done = true
                      clearTimeout(timer)
                      pendingPayConsents.delete(consentId)
                      abortSignal?.removeEventListener("abort", onAbort)
                      resolve(approved)
                    }
                    const onAbort = () => {
                      log.info("[pay] consent wait aborted", { name: clientName, consentId })
                      finish(false)
                    }
                    const timer = setTimeout(() => {
                      log.info("[pay] consent not approved within wait window", { name: clientName, consentId })
                      finish(false)
                    }, PAY_CONSENT_WAIT_MS)
                    pendingPayConsents.set(consentId, finish)
                    abortSignal?.addEventListener("abort", onAbort, { once: true })
                    void bridge
                      .promise(
                        bus
                          .publish(PayConsentRequired, {
                            name: clientName,
                            consentId,
                            total: info.total,
                            currency: info.currency,
                            settlementType: info.settlementType,
                            subTotal: info.subTotal,
                            taxes: info.taxes,
                            shippingAndHandling: info.shippingAndHandling,
                          })
                          .pipe(Effect.ignore),
                      )
                      .catch(() => finish(false))
                  })
              : undefined

            for (const mcpTool of listed) {
              result[sanitize(clientName) + "_" + sanitize(mcpTool.name)] = convertMcpTool(
                mcpTool,
                client,
                timeout,
                gateway,
                kya,
                requestPayConsent,
              )
            }
          }),
        { concurrency: "unbounded" },
      )
      return result
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client) => Promise<T[]>,
      label: string,
    ) {
      return Effect.forEach(
        Object.entries(s.clients).filter(([name]) => s.status[name]?.status === "connected"),
        ([clientName, client]) =>
          fetchFromClient(clientName, client, listFn, label).pipe(Effect.map((items) => Object.entries(items ?? {}))),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
    }

    const prompts = Effect.fn("MCP.prompts")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c) => c.listPrompts().then((r) => r.prompts), "prompts")
    })

    const resources = Effect.fn("MCP.resources")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c) => c.listResources().then((r) => r.resources), "resources")
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      const s = yield* InstanceState.get(state)
      const client = s.clients[clientName]
      if (!client) {
        log.warn(`[withClient] client not found for ${label}`, { clientName })
        return undefined
      }
      return yield* Effect.tryPromise({
        try: () => fn(client),
        catch: (e: any) => {
          log.error(`[withClient] failed to ${label}`, { clientName, ...meta, error: e?.message })
          return e
        },
      }).pipe(Effect.orElseSucceed(() => undefined))
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(clientName, (client) => client.getPrompt({ name, arguments: args }), "getPrompt", {
        promptName: name,
      })
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(clientName, (client) => client.readResource({ uri: resourceUri }), "readResource", {
        resourceUri,
      })
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const s = yield* InstanceState.get(state)
      if (s.config[mcpName]) return s.config[mcpName]

      const cfg = yield* cfgSvc.get()
      const mcpConfig = cfg.mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return mcpConfig
    })

    const requireMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return yield* new NotFoundError({ name: mcpName })
      return mcpConfig
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
      const url = remoteURL(mcpName, mcpConfig.url)
      if (!url) throw new Error(`Invalid MCP URL for "${mcpName}"`)

      // OAuth config is optional - if not provided, we'll use auto-discovery
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined

      // Resolve effective redirect URI: explicit redirectUri > callbackPort shorthand > default
      const effectiveRedirectUri =
        oauthConfig?.redirectUri ??
        (oauthConfig?.callbackPort ? `http://127.0.0.1:${oauthConfig.callbackPort}${OAUTH_CALLBACK_PATH}` : undefined)

      // Start the callback server with custom redirectUri if configured
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(effectiveRedirectUri))

      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      yield* auth.updateOAuthState(mcpName, oauthState)
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthProvider(
        mcpName,
        mcpConfig.url,
        {
          clientId: oauthConfig?.clientId,
          clientSecret: oauthConfig?.clientSecret,
          scope: oauthConfig?.scope,
          redirectUri: effectiveRedirectUri,
        },
        {
          onRedirect: async (url) => {
            capturedUrl = url
          },
        },
        auth,
        // allowInteractive = true: this is the explicit interactive flow, so DCR and
        // the authorization redirect are expected.
        true,
      )

      const transport = new StreamableHTTPClientTransport(url, { authProvider })

      return yield* Effect.tryPromise({
        try: () => {
          const client = new Client({ name: "opencode", version: InstallationVersion })
          return client
            .connect(transport)
            .then(() => ({ authorizationUrl: "", oauthState, client }) satisfies AuthResult)
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof UnauthorizedError && capturedUrl) {
            pendingOAuthTransports.set(mcpName, transport)
            return Effect.succeed({ authorizationUrl: capturedUrl.toString(), oauthState } satisfies AuthResult)
          }
          return Effect.die(error)
        }),
      )
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (mcpName: string) {
      const result = yield* startAuth(mcpName)
      if (!result.authorizationUrl) {
        const client = "client" in result ? result.client : undefined
        const mcpConfig = yield* requireMcpConfig(mcpName).pipe(
          Effect.tapError(() => Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)),
        )

        const listed = client ? yield* defs(mcpName, client, mcpConfig.timeout) : undefined
        if (!client || !listed) {
          yield* Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)
          return { status: "failed", error: "Failed to get tools" } as Status
        }

        const s = yield* InstanceState.get(state)
        yield* auth.clearOAuthState(mcpName)
        return yield* storeClient(s, mcpName, client, listed, mcpConfig.timeout)
      }

      log.info("[authenticate] opening browser for oauth", {
        mcpName,
        url: result.authorizationUrl,
        state: result.oauthState,
      })

      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, mcpName)

      yield* Effect.tryPromise(() => open(result.authorizationUrl)).pipe(
        Effect.flatMap((subprocess) =>
          Effect.callback<void, Error>((resume) => {
            const timer = setTimeout(() => resume(Effect.void), 500)
            subprocess.on("error", (err) => {
              clearTimeout(timer)
              resume(Effect.fail(err))
            })
            subprocess.on("exit", (code) => {
              if (code !== null && code !== 0) {
                clearTimeout(timer)
                resume(Effect.fail(new Error(`Browser open failed with exit code ${code}`)))
              }
            })
          }),
        ),
        Effect.catch(() => {
          log.warn("[authenticate] failed to open browser, user must open URL manually", { mcpName })
          return bus.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        }),
      )

      const code = yield* Effect.promise(() => callbackPromise)

      const storedState = yield* auth.getOAuthState(mcpName)
      if (storedState !== result.oauthState) {
        yield* auth.clearOAuthState(mcpName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      yield* auth.clearOAuthState(mcpName)
      return yield* finishAuth(mcpName, code)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, authorizationCode: string) {
      yield* requireMcpConfig(mcpName)
      const transport = pendingOAuthTransports.get(mcpName)
      if (!transport) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)

      const result = yield* Effect.tryPromise({
        try: () => transport.finishAuth(authorizationCode).then(() => true as const),
        catch: (error) => {
          log.error("[finishAuth] failed to finish oauth", { mcpName, error })
          return error
        },
      }).pipe(Effect.option)

      if (Option.isNone(result)) {
        return { status: "failed", error: "OAuth completion failed" } as Status
      }

      yield* auth.clearCodeVerifier(mcpName)
      pendingOAuthTransports.delete(mcpName)

      const mcpConfig = yield* requireMcpConfig(mcpName)

      return yield* createAndStore(mcpName, mcpConfig)
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      yield* auth.remove(mcpName)
      McpOAuthCallback.cancelPending(mcpName)
      pendingOAuthTransports.delete(mcpName)
      log.info("[removeAuth] removed oauth credentials", { mcpName })
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      if (!entry?.tokens) return "not_authenticated" as AuthStatus
      const expired = yield* auth.isTokenExpired(mcpName)
      return (expired ? "expired" : "authenticated") as AuthStatus
    })

    return Service.of({
      status,
      clients,
      tools,
      prompts,
      resources,
      add,
      connect,
      kyaAuthorize,
      kyaDecline,
      payConsent,
      disconnect,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

// --- Per-service runtime ---

export const defaultLayer = layer.pipe(
  Layer.provide(McpAuth.layer),
  Layer.provide(Bus.layer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export * as MCP from "."
