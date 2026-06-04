import { dynamicTool, type Tool, jsonSchema, type JSONSchema7 } from "ai"
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

const log = Log.create({ service: "mcp" })
const DEFAULT_TIMEOUT = 30_000

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
const StatusNotConnected = Schema.Struct({ status: Schema.Literal("not_connected") }).annotate({
  identifier: "MCPStatusNotConnected",
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

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusNotConnected,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

// Store transports for OAuth servers to allow finishing auth
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
const pendingOAuthTransports = new Map<string, TransportWithAuth>()

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type McpEntry = NonNullable<Config.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry): entry is ConfigMCP.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")

function remoteURL(key: string, value: string) {
  if (URL.canParse(value)) return new URL(value)
  log.warn("invalid remote mcp url", { key })
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
      if (value === "urn:ietf:params:oauth:grant-profile:kya") return ["kya", value]
      if (value === "urn:ietf:params:oauth:grant-profile:id-jag") return ["id-jag", value]
      return [value]
    })
}

function extractJwtFromText(input: string): string | undefined {
  // Skyfire QA tool currently returns a human-readable string like:
  // "Creation of KYA token for <id> is complete: <jwt>"
  const m = input.match(/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/)
  return m ? m[1] : undefined
}

function listTools(key: string, client: MCPClient, timeout: number) {
  return Effect.tryPromise({
    try: () => client.listTools(undefined, { timeout }),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(
    Effect.map((result) => result.tools),
    Effect.catch((error) => {
      if (!isOutputSchemaValidationError(error)) return Effect.fail(error)

      log.warn("failed to validate MCP tool output schemas, retrying without output schema validation", { key, error })
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

// Convert MCP tool definition to AI SDK Tool type
function convertMcpTool(mcpTool: MCPToolDef, client: MCPClient, timeout?: number): Tool {
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
    execute: async (args: unknown) => {
      return client.callTool(
        {
          name: mcpTool.name,
          arguments: (args || {}) as Record<string, unknown>,
        },
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          timeout,
        },
      )
    },
  })
}

function defs(key: string, client: MCPClient, timeout?: number) {
  return listTools(key, client, timeout ?? DEFAULT_TIMEOUT).pipe(
    Effect.catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
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
      log.error(`failed to get ${label}`, { clientName, error: e.message })
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
  readonly status: () => Effect.Effect<Record<string, Status>, never, Config.Service>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>, never, Config.Service>
  readonly tools: () => Effect.Effect<Record<string, Tool>, never, Config.Service>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>, never, Config.Service>
  readonly resources: () => Effect.Effect<Record<string, ResourceInfo & { client: string }>, never, Config.Service>
  readonly add: (
    name: string,
    mcp: ConfigMCP.Info,
  ) => Effect.Effect<{ status: Record<string, Status> | Status }, never, Config.Service>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError, Config.Service>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError, Config.Service>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined, never, Config.Service>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined, never, Config.Service>
  readonly startAuth: (
    mcpName: string,
  ) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, NotFoundError, Config.Service>
  readonly authenticate: (mcpName: string) => Effect.Effect<Status, NotFoundError, Config.Service>
  readonly finishAuth: (
    mcpName: string,
    authorizationCode: string,
  ) => Effect.Effect<Status, NotFoundError, Config.Service>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void, never, Config.Service>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean, NotFoundError, Config.Service>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean, never, Config.Service>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus, never, Config.Service>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const bus = yield* Bus.Service

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
    ) {
      log.info("connecting", {
        key,
        url: mcp.url,
        transportPreference: "transport" in mcp ? (mcp as any).transport : undefined,
        oauth: mcp.oauth === false ? false : "enabled",
      })

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
        log.info("oauth provider enabled", {
          key,
          hasClientId: !!oauthConfig?.clientId,
          hasClientSecret: !!oauthConfig?.clientSecret,
          hasScope: !!oauthConfig?.scope,
        })
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            callbackPort: oauthConfig?.callbackPort,
            redirectUri: oauthConfig?.redirectUri,
            // KYA is intentionally opaque to the MCP core service — it is only
            // used by the OAuth client provider when RAS metadata opts in.
            ...(oauthConfig && "kya" in oauthConfig ? { kya: (oauthConfig as any).kya } : {}),
          },
          {
            onRedirect: async (url) => {
              log.info("oauth redirect requested", { key, url: url.toString() })
            },
          },
          auth,
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> =
        mcp.transport === "streamable_http"
          ? [
              {
                name: "StreamableHTTP",
                transport: new StreamableHTTPClientTransport(url, {
                  authProvider,
                  requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
                }),
              },
            ]
          : mcp.transport === "sse"
            ? [
                {
                  name: "SSE",
                  transport: new SSEClientTransport(url, {
                    authProvider,
                    requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
                  }),
                },
              ]
            : [
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
      let streamableHttpRetry = 0

      for (const { name, transport } of transports) {
        log.info("transport connect attempt", { key, transport: name, timeout: connectTimeout })
        const result = yield* connectTransport(transport, connectTimeout).pipe(
          Effect.map((client) => ({ client, transportName: name })),
          Effect.catch((error) => {
            const lastError = error instanceof Error ? error : new Error(String(error))

            const isAuthError =
              error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

            if (isAuthError) {
              log.info("mcp server requires authentication", { key, transport: name })

              // If StreamableHTTP hits an auth-required state, don't attempt SSE
              // fallback (many servers don't implement SSE and return 404).
              if (name === "StreamableHTTP") {
                lastStatus = { status: "needs_auth" as const }
              }

              const hintedDcr = lastError.message.includes("registration") || lastError.message.includes("client_id")

              return Effect.gen(function* () {
                const minted = yield* Effect.gen(function* () {
                  const cfgSvc = yield* Config.Service
                  const cfg = yield* cfgSvc.get()

                  // Detect KYA support up front so we can avoid triggering interactive OAuth redirects.
                  const kyaSupport = yield* Effect.tryPromise({
                    try: async () => {
                      const resourceOrigin = new URL(mcp.url).origin
                      const protectedRes = await fetch(
                        new URL("/.well-known/oauth-protected-resource", resourceOrigin),
                        {
                          headers: { accept: "application/json" },
                        },
                      )
                      if (!protectedRes.ok) return { supportsKya: false, authServer: undefined as string | undefined }

                      const protectedJson = (await protectedRes.json()) as any
                      const authServers =
                        Array.isArray(protectedJson?.authorization_servers) &&
                        protectedJson.authorization_servers.every((x: any) => typeof x === "string")
                          ? (protectedJson.authorization_servers as string[])
                          : []
                      const authServer = authServers[0]
                      if (!authServer) return { supportsKya: false, authServer: undefined as string | undefined }

                      const rfc8414 = await fetch(new URL("/.well-known/oauth-authorization-server", authServer), {
                        headers: { accept: "application/json" },
                      })
                      const asJson = rfc8414.ok
                        ? await rfc8414.json()
                        : await fetch(new URL("/.well-known/openid-configuration", authServer), {
                            headers: { accept: "application/json" },
                          }).then((r) => (r.ok ? r.json() : undefined))

                      const profiles = authorizationGrantProfilesSupported(asJson)
                      log.info("kya resource AS metadata", {
                        key,
                        resourceOrigin,
                        authServer,
                        supportsKya: profiles.includes("kya"),
                        profiles: profiles.slice(0, 8),
                      })
                      return { supportsKya: profiles.includes("kya"), authServer }
                    },
                    catch: () => ({ supportsKya: false, authServer: undefined as string | undefined }),
                  })

                  if (!kyaSupport.supportsKya) return false

                  // If the SDK tried to start an interactive auth-code flow for a KYA-capable resource,
                  // don't proceed with redirects — we will mint/exchange a token non-interactively.
                  // (The redirect already happened before we got here; this prevents any further
                  // interactive fallback state like DCR from becoming the surfaced reason.)

                  const issuer = cfg.mcp?.skyfire
                  if (!issuer || typeof issuer !== "object" || issuer === null || !("type" in issuer)) {
                    log.info("kya supported but no issuer configured", { key })
                    return false
                  }

                  if ((issuer as any).type !== "remote") {
                    log.info("kya supported but issuer is not remote", { key, type: (issuer as any).type })
                    return false
                  }

                  const issuerRemote = issuer as unknown as ConfigMCP.Remote
                  const issuerHeaders = issuerRemote.headers ?? {}

                  const buyerTag = process.env.OPENCODE_KYA_BUYER_TAG
                  const sellerServiceId = process.env.OPENCODE_KYA_SELLER_SERVICE_ID

                  if (!sellerServiceId) {
                    log.warn("kya mint skipped: missing OPENCODE_KYA_SELLER_SERVICE_ID", { key })
                    return undefined
                  }

                  const issuerTransport = new StreamableHTTPClientTransport(new URL(issuerRemote.url), {
                    requestInit: { headers: issuerHeaders },
                  })
                  const issuerClient = new Client({ name: "opencode", version: InstallationVersion })
                  yield* Effect.tryPromise({
                    try: () => issuerClient.connect(issuerTransport),
                    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
                  })

                  log.info("kya mint: calling skyfire create-kya-token", {
                    key,
                    issuerUrl: issuerRemote.url,
                    hasBuyerTag: !!buyerTag,
                    hasSellerServiceId: !!sellerServiceId,
                  })

                  const toolResult = yield* Effect.tryPromise({
                    try: () =>
                      issuerClient.callTool({
                        name: "create-kya-token",
                        arguments: {
                          // Skyfire QA issuer requires sellerServiceId.
                          sellerServiceId,
                          ...(buyerTag ? { buyerTag } : {}),
                        },
                      }),
                    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
                  }).pipe(Effect.ensuring(Effect.tryPromise(() => issuerClient.close()).pipe(Effect.ignore)))

                  const text = Array.isArray((toolResult as any).content)
                    ? (toolResult as any).content.map((c: any) => c.text ?? "").join("\n")
                    : String((toolResult as any).content ?? "")

                  log.info("kya mint: skyfire tool response", { key, textPrefix: text.slice(0, 120) })

                  const assertion = extractJwtFromText(text)
                  if (!assertion) {
                    log.warn("kya mint failed: could not extract jwt from skyfire tool output", { key })
                    return false
                  }

                  // Exchange KYA assertion for an OAuth access token at the resource's auth server.
                  const oauthMetadata = yield* Effect.tryPromise({
                    try: async () => {
                      const authServer = kyaSupport.authServer
                      if (!authServer) return undefined
                      const rfc8414 = await fetch(new URL("/.well-known/oauth-authorization-server", authServer), {
                        headers: { accept: "application/json" },
                      })
                      return rfc8414.ok ? ((await rfc8414.json()) as any) : undefined
                    },
                    catch: () => undefined,
                  })

                  const tokenEndpoint =
                    oauthMetadata &&
                    typeof oauthMetadata === "object" &&
                    typeof (oauthMetadata as any).token_endpoint === "string"
                      ? ((oauthMetadata as any).token_endpoint as string)
                      : undefined
                  if (!tokenEndpoint) {
                    log.warn("kya exchange skipped: auth server metadata missing token_endpoint", { key })
                    return false
                  }

                  const form = new URLSearchParams({
                    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                    assertion,
                  })

                  const tokenJson = yield* Effect.tryPromise({
                    try: async () => {
                      const res = await fetch(tokenEndpoint, {
                        method: "POST",
                        headers: { "content-type": "application/x-www-form-urlencoded" },
                        body: form,
                      })
                      if (!res.ok) {
                        throw new Error(`OAuth token exchange failed (${res.status}): ${await res.text()}`)
                      }
                      return (await res.json()) as any
                    },
                    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
                  })

                  const accessToken =
                    tokenJson && typeof tokenJson.access_token === "string" ? tokenJson.access_token : undefined
                  if (!accessToken) {
                    log.warn("kya exchange failed: missing access_token", { key })
                    return false
                  }

                  yield* auth.updateTokens(
                    key,
                    { accessToken, refreshToken: undefined, expiresAt: undefined, scope: undefined },
                    // McpOAuthProvider normalizes serverUrl to origin (not the /mcp path),
                    // and McpAuth.getForUrl() keys tokens by that value.
                    new URL(mcp.url).origin,
                  )

                  // We have credentials now; retry the primary transport once so a single
                  // user "connect" action can reach the connected state.
                  if (name === "StreamableHTTP" && streamableHttpRetry === 0) {
                    streamableHttpRetry = 1
                    log.info("kya mint: stored token, retrying StreamableHTTP connect", { key })
                  }

                  return true
                }).pipe(
                  Effect.catch((e) => {
                    const msg = e instanceof Error ? e.message : String(e)
                    log.warn("kya mint failed", { key, error: msg })
                    return Effect.succeed(false)
                  }),
                )

                // If we minted a token, we either scheduled a retry (sentinel) or we can just
                // fall through and let the outer loop continue.
                if (minted) return undefined

                // If KYA isn't available, and the error suggests DCR is required, surface that.
                if (hintedDcr) {
                  lastStatus = {
                    status: "needs_client_registration" as const,
                    error: "Server does not support dynamic client registration. Please provide clientId in config.",
                  }
                  return yield* bus
                    .publish(TuiEvent.ToastShow, {
                      title: "MCP Authentication Required",
                      message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                      variant: "warning",
                      duration: 8000,
                    })
                    .pipe(Effect.ignore, Effect.as(undefined))
                }

                // Only StreamableHTTP supports finishAuth() in the MCP SDK.
                if (name === "StreamableHTTP") pendingOAuthTransports.set(key, transport)
                lastStatus = { status: "needs_auth" as const }
                return yield* bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires authentication. Run: opencode mcp auth ${key}`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              })
            }

            log.debug("transport connection failed", {
              key,
              transport: name,
              url: mcp.url,
              error: lastError.message,
              cause: (lastError as any).cause,
            })

            // Many MCP servers don't implement SSE transport at all. When SSE
            // returns a plain 404, treat it as "unsupported" rather than a
            // connection failure that overrides the primary StreamableHTTP
            // outcome.
            if (name === "SSE" && /Non-200 status code \(404\)/i.test(lastError.message)) {
              return Effect.succeed(undefined)
            }

            lastStatus = {
              status: "failed" as const,
              error: `${name} error for ${mcp.url}: ${lastError.message}`,
            }
            return Effect.succeed(undefined)
          }),
        )
        if (result) {
          log.info("connected", { key, transport: result.transportName })
          return { client: result.client as MCPClient | undefined, status: { status: "connected" } as Status }
        }

        // If KYA minting requested a StreamableHTTP retry, run it now (once) before
        // attempting any other transports.
        if (name === "StreamableHTTP" && streamableHttpRetry === 1) {
          // Reset immediately to avoid loops.
          streamableHttpRetry = 2
          continue
        }
        // If StreamableHTTP reached an auth-required state, don't attempt SSE
        // fallback (many servers don't implement SSE and return 404).
        if (
          name === "StreamableHTTP" &&
          (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration")
        ) {
          break
        }
      }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ??
          ({
            status: "failed",
            error: `Failed to connect to ${mcp.url} (no transport succeeded)` as const,
          } as const)) as Status,
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
        log.info(`mcp stderr: ${chunk.toString()}`, { key })
      })

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      return yield* connectTransport(transport, connectTimeout).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status } => ({
          client,
          status: { status: "connected" },
        })),
        Effect.catch((error): Effect.Effect<{ client: MCPClient | undefined; status: Status }> => {
          const msg = error instanceof Error ? error.message : String(error)
          log.error("local mcp startup failed", { key, command: mcp.command, cwd, error: msg })
          return Effect.succeed({ client: undefined, status: { status: "failed", error: msg } })
        }),
      )
    })

    const create = Effect.fn("MCP.create")(function* (key: string, mcp: ConfigMCP.Info) {
      if (mcp.enabled === false) {
        log.info("mcp server disabled", { key })
        return DISABLED_RESULT
      }

      log.info("found", { key, type: mcp.type })

      const { client: mcpClient, status } =
        mcp.type === "remote"
          ? yield* connectRemote(key, mcp as ConfigMCP.Info & { type: "remote" })
          : yield* connectLocal(key, mcp as ConfigMCP.Info & { type: "local" })

      if (!mcpClient) {
        return { status } satisfies CreateResult
      }

      const listed = yield* defs(key, mcpClient, mcp.timeout)
      if (!listed) {
        yield* Effect.tryPromise(() => mcpClient.close()).pipe(Effect.ignore)
        return { status: { status: "failed", error: "Failed to get tools" } } satisfies CreateResult
      }

      log.info("create() successfully created client", { key, toolCount: listed.length })
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
        log.info("tools list changed notification received", { server: name })
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
        const bridge = yield* EffectBridge.make()
        const config = {} as Record<string, unknown>
        const s: State = {
          config: {},
          status: {},
          clients: {},
          defs: {},
        }

        // Note: we intentionally don't eagerly connect here, because this
        // initializer must be Scope-only (no access to other services like
        // Config). MCP clients are connected on-demand.

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

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (name: string, mcp: ConfigMCP.Info) {
      const s = yield* InstanceState.get(state)
      const result = yield* create(name, mcp)

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

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const mcp = yield* requireMcpConfig(name)
      yield* createAndStore(name, { ...mcp, enabled: true })
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

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const defaultTimeout = cfg.experimental?.mcp_timeout

      const connectedClients = Object.entries(s.clients).filter(
        ([clientName]) => s.status[clientName]?.status === "connected",
      )

      yield* Effect.forEach(
        connectedClients,
        ([clientName, client]) =>
          Effect.gen(function* () {
            const mcpConfig = config[clientName]
            const entry = mcpConfig && isMcpConfigured(mcpConfig) ? mcpConfig : s.config[clientName]

            const listed = s.defs[clientName]
            if (!listed) {
              log.warn("missing cached tools for connected server", { clientName })
              return
            }

            const timeout = entry?.timeout ?? defaultTimeout
            for (const mcpTool of listed) {
              result[sanitize(clientName) + "_" + sanitize(mcpTool.name)] = convertMcpTool(mcpTool, client, timeout)
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
        log.warn(`client not found for ${label}`, { clientName })
        return undefined
      }
      return yield* Effect.tryPromise({
        try: () => fn(client),
        catch: (e: any) => {
          log.error(`failed to ${label}`, { clientName, ...meta, error: e?.message })
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
          ...(oauthConfig && "kya" in oauthConfig ? { kya: (oauthConfig as any).kya } : {}),
        },
        {
          onRedirect: async (url) => {
            capturedUrl = url
          },
        },
        auth,
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

      log.info("opening browser for oauth", { mcpName, url: result.authorizationUrl, state: result.oauthState })

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
          log.warn("failed to open browser, user must open URL manually", { mcpName })
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
          log.error("failed to finish oauth", { mcpName, error })
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
      log.info("removed oauth credentials", { mcpName })
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
