import { Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"
import { AcceptedTokens } from "@/mcp/oauth-provider"

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
}).annotate({ identifier: "McpLocalConfig" })
export type Local = Schema.Schema.Type<typeof Local>

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

  /**
   * KYA (Know Your Agent) configuration. Only used when the Resource
   * Authorization Server metadata advertises
   * `authorization_grant_profiles_supported: ["kya"]`.
   */
  kya: Schema.optional(
    Schema.Struct({
      apiKey: Schema.optional(Schema.String).annotate({ description: "API key sent to the KYA token issuer" }),
      tokenType: Schema.optional(Schema.Enum(AcceptedTokens)).annotate({
        description: "Token type value sent to issuer",
      }),
      buyerTag: Schema.optional(Schema.String).annotate({ description: "buyerTag field sent to issuer" }),
      tokenAmount: Schema.optional(Schema.Number).annotate({ description: "tokenAmount field sent to issuer" }),
      sellerServiceId: Schema.optional(Schema.String).annotate({
        description: "sellerServiceId field sent to issuer (defaults to empty string)",
      }),
      expiresAt: Schema.optional(Schema.Number).annotate({
        description: "expiresAt as unix seconds sent to issuer (defaults to 5 minutes)",
      }),
    }).annotate({ identifier: "McpOAuthKyaConfig" }),
  ),
}).annotate({ identifier: "McpOAuthConfig" })
export type OAuth = Schema.Schema.Type<typeof OAuth>

export const Remote = Schema.Struct({
  type: Schema.Literal("remote").annotate({ description: "Type of MCP server connection" }),
  url: Schema.String.annotate({ description: "URL of the remote MCP server" }),
  transport: Schema.optional(
    Schema.Union([Schema.Literal("streamable_http"), Schema.Literal("sse")]).annotate({ identifier: "McpTransport" }),
  ).annotate({
    description:
      "Transport preference for remote MCP connections. Defaults to trying StreamableHTTP first (then SSE). Set to streamable_http to skip SSE for servers that don't support it.",
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
}).annotate({ identifier: "McpRemoteConfig" })
export type Remote = Schema.Schema.Type<typeof Remote>

export const Info = Schema.Union([Local, Remote]).annotate({ discriminator: "type" })
export type Info = Schema.Schema.Type<typeof Info>

export * as ConfigMCP from "./mcp"
