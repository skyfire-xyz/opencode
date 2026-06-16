import { Schema } from "effect"
import { PositiveInt, type DeepMutable } from "@opencode-ai/core/schema"

export const Local = Schema.Struct({
  type: Schema.Literal("local").annotate({ description: "Type of MCP server connection" }),
  command: Schema.mutable(Schema.Array(Schema.String)).annotate({
    description: "Command and arguments to run the MCP server",
  }),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Environment variables to set when running the MCP server",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified.",
  }),
  capabilities: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ tool: Schema.String }))).annotate({
    description:
      'Capability URIs this server can fulfill, mapped to the tool that mints the token. e.g. { "org.kyapay:pay": { "tool": "create-pay-token" } }',
  }),
}).annotate({ identifier: "McpLocalConfig" })
// `Config.Info` runs the whole config through `DeepMutable`, so the mcp entries
// embedded there are mutable. Mirror that here so standalone `ConfigMCP` types
// stay assignable to the config-derived ones (e.g. in predicates over Config.Info["mcp"]).
export type Local = DeepMutable<Schema.Schema.Type<typeof Local>>

export const OAuth = Schema.Struct({
  clientId: Schema.optional(Schema.String).annotate({
    description: "OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted.",
  }),
  clientSecret: Schema.optional(Schema.String).annotate({
    description: "OAuth client secret (if required by the authorization server)",
  }),
  scope: Schema.optional(Schema.String).annotate({ description: "OAuth scopes to request during authorization" }),
  callbackPort: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))).annotate({
    description:
      "Port for the local OAuth callback server (default: 19876). Shorthand for redirectUri when only the port needs changing. Ignored if redirectUri is set.",
  }),
  redirectUri: Schema.optional(Schema.String).annotate({
    description: "OAuth redirect URI (default: http://127.0.0.1:19876/mcp/oauth/callback).",
  }),
}).annotate({ identifier: "McpOAuthConfig" })
export type OAuth = DeepMutable<Schema.Schema.Type<typeof OAuth>>

export const Capability = Schema.Struct({
  tool: Schema.optional(Schema.String).annotate({
    description: "MCP tool name to call for this capability.",
  }),
}).annotate({ identifier: "McpCapabilityConfig" })
export type Capability = DeepMutable<Schema.Schema.Type<typeof Capability>>

export const Remote = Schema.Struct({
  type: Schema.Literal("remote").annotate({ description: "Type of MCP server connection" }),
  url: Schema.String.annotate({ description: "URL of the remote MCP server" }),
  transport: Schema.optional(Schema.Union([Schema.Literal("streamable_http"), Schema.Literal("sse")])).annotate({
    description:
      "Transport preference for remote MCP servers. Defaults to trying StreamableHTTP first, then SSE as a fallback.",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Headers to send with the request",
  }),
  oauth: Schema.optional(Schema.Union([OAuth, Schema.Literal(false)])).annotate({
    description: "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified.",
  }),
  capabilities: Schema.optional(
    Schema.Union([
      Schema.Record(Schema.String, Capability).annotate({
        description:
          'Capability configuration keyed by URI (e.g. { "org.kyapay:kya": { "tool": "create-kya-token" }, "org.kyapay:pay": { "tool": "create-pay-token" } }).',
      }),
      Schema.Array(Schema.String).annotate({
        description: "Legacy list of capability URIs supported by this MCP server (e.g. org.kyapay:kya).",
      }),
    ]),
  ).annotate({ description: "Capabilities supported by this MCP server" }),
}).annotate({ identifier: "McpRemoteConfig" })
export type Remote = DeepMutable<Schema.Schema.Type<typeof Remote>>

export const Info = Schema.Union([Local, Remote]).annotate({ discriminator: "type" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

export * as ConfigMCP from "./mcp"
