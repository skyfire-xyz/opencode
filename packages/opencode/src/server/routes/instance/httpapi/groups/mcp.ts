import { MCP } from "@/mcp"
import { ConfigMCP } from "@/config/mcp"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { McpServerNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { QueryBoolean } from "./query"
import { described } from "./metadata"

// connect accepts an optional `kyaConsent` query flag: the user's
// "Sign in with Skyfire KYA" confirmation. Without it, a KYA server is gated
// (needs_kya_consent); with it, the KYA token is minted and the server connects.
const ConnectQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  kyaConsent: Schema.optional(QueryBoolean),
})

// kyaAuthorize requires the caller to pass consentGiven=true, mirroring the
// kyaConsent flag on connect. This prevents the endpoint from being used to
// silently mint tokens without explicit user confirmation.
const KyaAuthorizeQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  consentGiven: QueryBoolean,
})

// payConsent resolves a pending payment-consent prompt: the user's Yes/No from
// the order-total dialog the gateway raised before minting a pay token.
const PayConsentQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  consentId: Schema.String,
  approved: QueryBoolean,
})

export const AddPayload = Schema.Struct({
  name: Schema.String,
  config: ConfigMCP.Info,
})

export const StatusMap = Schema.Record(Schema.String, MCP.Status)
export const AuthStartResponse = Schema.Struct({
  authorizationUrl: Schema.String,
  oauthState: Schema.String,
})
export const AuthCallbackPayload = Schema.Struct({
  code: Schema.String,
})
export const AuthRemoveResponse = Schema.Struct({
  success: Schema.Literal(true),
})
export class UnsupportedOAuthError extends Schema.ErrorClass<UnsupportedOAuthError>("McpUnsupportedOAuthError")(
  { error: Schema.String },
  { httpApiStatus: 400 },
) {}

export const McpPaths = {
  status: "/mcp",
  auth: "/mcp/:name/auth",
  authCallback: "/mcp/:name/auth/callback",
  authAuthenticate: "/mcp/:name/auth/authenticate",
  connect: "/mcp/:name/connect",
  kyaAuthorize: "/mcp/:name/kya-authorize",
  payConsent: "/mcp/:name/pay-consent",
  disconnect: "/mcp/:name/disconnect",
} as const

export const McpApi = HttpApi.make("mcp")
  .add(
    HttpApiGroup.make("mcp")
      .add(
        HttpApiEndpoint.get("status", McpPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Status), "MCP server status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.status",
            summary: "Get MCP status",
            description: "Get the status of all Model Context Protocol (MCP) servers.",
          }),
        ),
        HttpApiEndpoint.post("add", McpPaths.status, {
          query: WorkspaceRoutingQuery,
          payload: AddPayload,
          success: described(StatusMap, "MCP server added successfully"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.add",
            summary: "Add MCP server",
            description: "Dynamically add a new Model Context Protocol (MCP) server to the system.",
          }),
        ),
        HttpApiEndpoint.post("authStart", McpPaths.auth, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(AuthStartResponse, "OAuth flow started"),
          error: [UnsupportedOAuthError, McpServerNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.start",
            summary: "Start MCP OAuth",
            description: "Start OAuth authentication flow for a Model Context Protocol (MCP) server.",
          }),
        ),
        HttpApiEndpoint.post("authCallback", McpPaths.authCallback, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: AuthCallbackPayload,
          success: described(MCP.Status, "OAuth authentication completed"),
          error: [HttpApiError.BadRequest, McpServerNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.callback",
            summary: "Complete MCP OAuth",
            description:
              "Complete OAuth authentication for a Model Context Protocol (MCP) server using the authorization code.",
          }),
        ),
        HttpApiEndpoint.post("authAuthenticate", McpPaths.authAuthenticate, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(MCP.Status, "OAuth authentication completed"),
          error: [UnsupportedOAuthError, McpServerNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.authenticate",
            summary: "Authenticate MCP OAuth",
            description: "Start OAuth flow and wait for callback (opens browser).",
          }),
        ),
        HttpApiEndpoint.delete("authRemove", McpPaths.auth, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(AuthRemoveResponse, "OAuth credentials removed"),
          error: McpServerNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.remove",
            summary: "Remove MCP OAuth",
            description: "Remove OAuth credentials for an MCP server.",
          }),
        ),
        HttpApiEndpoint.post("connect", McpPaths.connect, {
          params: { name: Schema.String },
          query: ConnectQuery,
          success: described(Schema.Boolean, "MCP server connected successfully"),
          error: McpServerNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.connect",
            description:
              "Connect an MCP server. Pass kyaConsent=true to confirm a Skyfire KYA sign-in for a server that requires it.",
          }),
        ),
        HttpApiEndpoint.post("kyaAuthorize", McpPaths.kyaAuthorize, {
          params: { name: Schema.String },
          query: KyaAuthorizeQuery,
          success: described(Schema.Boolean, "Skyfire KYA token minted for the server"),
          error: [McpServerNotFoundError, HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.kyaAuthorize",
            description:
              "Mint a Skyfire KYA access token for an already-connected MCP server whose gated tools returned 401. Does not reconnect; the live transport uses the stored token on its next request.",
          }),
        ),
        HttpApiEndpoint.post("payConsent", McpPaths.payConsent, {
          params: { name: Schema.String },
          query: PayConsentQuery,
          success: described(Schema.Boolean, "Payment consent recorded (resolved a pending prompt)"),
          error: McpServerNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.payConsent",
            description:
              "Approve or decline a pending payment-consent prompt raised by the gateway before minting a pay token. Returns true when a pending prompt was resolved.",
          }),
        ),
        HttpApiEndpoint.post("disconnect", McpPaths.disconnect, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "MCP server disconnected successfully"),
          error: McpServerNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.disconnect",
            description: "Disconnect an MCP server.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "mcp",
          description: "Experimental HttpApi MCP routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
