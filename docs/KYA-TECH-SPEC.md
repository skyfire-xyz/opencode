# KYA + OAuth + MCP Integration — Technical Specification

How OpenCode authenticates to protected MCP servers with the KYA (Know Your
Agent) grant profile, when it falls back to interactive OAuth, and how the
payment gateway (`org.kyapay:pay`) reuses the same capability machinery. It
covers the code paths, data structures, and network exchanges involved, for
engineers working on the MCP transport, auth, and gateway layers.

> This is the design reference. For a hands-on runbook (starting the mock
> servers, connecting from the web UI, reading the logs), see [KYA.md](KYA.md).
> Where the two overlap, this doc is authoritative on behavior and KYA.md on
> operation.

---

## 1. Purpose & Background

MCP (Model Context Protocol) remote servers are HTTP resources that may require
OAuth 2.1 authorization. The standard MCP SDK flow for an unauthenticated server
is the interactive **Authorization Code + PKCE** flow: open a browser, the user
consents, an authorization code comes back to a loopback redirect, and the code
is exchanged for an access token.

That flow assumes a _human_ is present to consent. OpenCode acts as an
**autonomous agent**, so we want a **non-interactive** way to obtain an access
token where the agent's identity (not a human's browser session) is what the
resource server authorizes. That is what **KYA** provides:

1. A trusted **issuer** (Skyfire's MCP server) mints a signed **KYA assertion**
   (a JWT) that attests to the agent's identity and the seller it wants to act
   against.
2. OpenCode exchanges that assertion at the resource's **Authorization Server**
   (AS) for a normal OAuth access token, using RFC 7523's
   `urn:ietf:params:oauth:grant-type:jwt-bearer` grant.
3. OpenCode uses that access token as a plain `Bearer` credential against the
   MCP server, which validates it as an ordinary OAuth 2.1 resource server with
   **no KYA awareness**.

KYA is therefore a _non-interactive optimization layered on top of standard
OAuth_. When a server doesn't advertise KYA (or KYA minting can't be performed),
OpenCode falls back to the interactive flow.

The same "config capability → issuer MCP tool" machinery is reused at
**tool-call time** by the **payment gateway** (`org.kyapay:pay`) to mint
_payment_ tokens mid-conversation. That is a sibling feature documented in
§12.

---

## 2. Terminology & Actors

| Term                      | Meaning                                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent**                 | OpenCode itself (the instance server process).                                                                                                                                    |
| **MCP server / Resource** | The protected remote MCP server the agent wants to use (e.g. `merchant-mcp`). A plain OAuth 2.1 resource server.                                                                  |
| **Resource AS**           | The OAuth Authorization Server protecting the resource. Hosts discovery metadata + the `/token` endpoint.                                                                         |
| **KYA Issuer**            | A remote MCP server that advertises capability `org.kyapay:kya` and exposes a tool (e.g. `create-kya-token`) that mints KYA assertions. In practice this is Skyfire's MCP server. |
| **KYA assertion**         | A signed JWT minted by the issuer, attesting agent identity + seller. _Not_ an OAuth access token.                                                                                |
| **Access token**          | A normal OAuth 2.1 Bearer token issued by the Resource AS in exchange for the assertion.                                                                                          |
| **Capability**            | A URI like `org.kyapay:kya` or `org.kyapay:pay` declared in config, mapped to the issuer tool that fulfills it.                                                                   |
| **Seller selector**       | The argument passed to the issuer tool identifying the seller: either `sellerServiceId` (a UUID) or `sellerDomainOrUrl` (a hostname).                                             |

**Relevant RFCs / specs:**

- **RFC 9728** — OAuth 2.0 Protected Resource Metadata (`/.well-known/oauth-protected-resource`).
- **RFC 8414** — OAuth 2.0 Authorization Server Metadata (`/.well-known/oauth-authorization-server`).
- **RFC 7523** — JWT Profile for OAuth Client Authentication and Authorization Grants (`grant_type=…:jwt-bearer`).
- **RFC 7591** — OAuth 2.0 Dynamic Client Registration (used only in the interactive fallback).
- **RFC 7636** — PKCE (interactive fallback).
- **KYA / ID-JAG grant profile drafts** — advertised via `authorization_grant_profiles_supported` in AS metadata; profile URN `urn:ietf:params:oauth:grant-profile:kya`.

Phase labels **B / C / D** used throughout map to the Skyfire×Okta design spec:

- **Phase B** — discovery (find the Resource AS and read its grant profiles).
- **Phase C** — mint the KYA assertion at the issuer.
- **Phase D** — exchange the assertion for an access token and use it.

---

## 3. Architecture Overview

### 3.1 Component / file map

| File                                                                                                                                                                                         | Responsibility                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [packages/opencode/src/mcp/index.ts](../packages/opencode/src/mcp/index.ts)                                                                                                                  | The `MCP` Effect service. Owns connection lifecycle, the silent-KYA orchestration (`trySilentKya`), transport selection, status state, and the interactive-auth entry points (`startAuth`/`authenticate`/`finishAuth`).                                                                                                                   |
| [packages/opencode/src/mcp/kya.ts](../packages/opencode/src/mcp/kya.ts)                                                                                                                      | Pure KYA helpers: capability detection, issuer selection from config, JWT extraction, RFC 9728/8414 discovery, RFC 7523 token exchange. **Note:** its `discoverResourceAuthServer` + `exchangeAssertionForAccessToken` are used by the CLI `mcp debug` path only; the silent connect path in `index.ts` has its own inline copies (§7.5). |
| [packages/opencode/src/mcp/oauth-provider.ts](../packages/opencode/src/mcp/oauth-provider.ts)                                                                                                | `McpOAuthProvider` implementing the MCP SDK's `OAuthClientProvider`. Bridges the SDK's interactive OAuth to OpenCode's token store; defers KYA to the out-of-band path.                                                                                                                                                                   |
| [packages/opencode/src/mcp/oauth-callback.ts](../packages/opencode/src/mcp/oauth-callback.ts)                                                                                                | Local loopback HTTP server that receives the `?code=…` redirect for the interactive flow.                                                                                                                                                                                                                                                 |
| [packages/opencode/src/mcp/auth.ts](../packages/opencode/src/mcp/auth.ts)                                                                                                                    | `McpAuth` Effect service: persistent token/client/state store at `~/.local/share/opencode/mcp-auth.json`.                                                                                                                                                                                                                                 |
| [packages/opencode/src/mcp/gateway.ts](../packages/opencode/src/mcp/gateway.ts)                                                                                                              | The payment gateway: intercepts tool calls, catches `payments/*` signals, mints `org.kyapay:pay` tokens via the issuer, retries the tool.                                                                                                                                                                                                 |
| [packages/opencode/src/config/mcp.ts](../packages/opencode/src/config/mcp.ts)                                                                                                                | Config schema for MCP entries (`Local` / `Remote`), OAuth config, and the `capabilities` schema.                                                                                                                                                                                                                                          |
| [packages/core/src/flag/flag.ts](../packages/core/src/flag/flag.ts)                                                                                                                          | Environment flags (`OPENCODE_KYA_SELLER_SERVICE_ID`, `OPENCODE_KYA_INTERACTIVE_FALLBACK`).                                                                                                                                                                                                                                                |
| [packages/opencode/src/cli/cmd/mcp.ts](../packages/opencode/src/cli/cmd/mcp.ts)                                                                                                              | CLI surface: `mcp list / auth / logout / add / debug`. `debug` runs a standalone KYA mint for diagnosis.                                                                                                                                                                                                                                  |
| [packages/opencode/script/mock-mcp-kya-server.ts](../packages/opencode/script/mock-mcp-kya-server.ts)                                                                                        | Local mock of the protected MCP server **and** Resource AS, for end-to-end testing.                                                                                                                                                                                                                                                       |
| [packages/app/src/components/dialog-select-mcp.tsx](../packages/app/src/components/dialog-select-mcp.tsx), [status-popover-body.tsx](../packages/app/src/components/status-popover-body.tsx) | Web UI entry points that call `connect` / `mcp.auth.authenticate`.                                                                                                                                                                                                                                                                        |

### 3.2 High-level data flow

```
                 ┌────────────────────────── OpenCode instance server ──────────────────────────┐
                 │                                                                                │
  web UI / CLI ──┼─▶ MCP.connect(name) ─▶ connectRemote ─▶ [transport connect]                   │
                 │                              │                                                 │
                 │                              ▼ (401 / UnauthorizedError)                       │
                 │                        trySilentKya ──── Phase B: discovery ─────┐             │
                 │                              │                                   ▼             │
                 │                              │                          Resource AS metadata   │
                 │                              ▼ Phase C                                         │
                 │                        KYA Issuer (Skyfire MCP) ── create-kya-token ─▶ JWT     │
                 │                              ▼ Phase D                                         │
                 │                        Resource AS /token (jwt-bearer) ─▶ access_token         │
                 │                              ▼                                                 │
                 │                        McpAuth.updateTokens (persist)                          │
                 │                              ▼                                                 │
                 │                        retry StreamableHTTP w/ Bearer ─▶ connected             │
                 └────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Configuration Model

### 4.1 Remote server schema

Defined in [packages/opencode/src/config/mcp.ts](../packages/opencode/src/config/mcp.ts).
A remote MCP entry:

```jsonc
{
  "type": "remote",
  "url": "http://127.0.0.1:8787/mcp",
  "transport": "streamable_http",      // optional: "streamable_http" | "sse"
  "enabled": true,                      // optional
  "headers": { "x-custom": "…" },       // optional, sent on every request
  "oauth": { /* … */ } | false,         // optional; false disables OAuth auto-detect
  "timeout": 30000,                     // optional, ms
  "capabilities": { /* … */ }           // optional, see §5
}
```

OAuth sub-config ([McpOAuthConfig](../packages/opencode/src/config/mcp.ts#L28-L43)):

```jsonc
"oauth": {
  "clientId": "…",        // pre-registered client; skips dynamic registration
  "clientSecret": "…",
  "scope": "…",
  "callbackPort": 19876,  // shorthand for redirectUri port
  "redirectUri": "http://127.0.0.1:19876/mcp/oauth/callback"
}
```

### 4.2 The `capabilities` schema

`capabilities` is a **union** of two forms ([Remote.capabilities](../packages/opencode/src/config/mcp.ts#L72-L82)):

1. **Record form (canonical):** maps a capability URI to a `{ tool }` object.
   The `tool` is the MCP tool on that server which mints the token for the
   capability.

   ```jsonc
   "capabilities": {
     "org.kyapay:kya": { "tool": "create-kya-token" },
     "org.kyapay:pay": { "tool": "create-pay-token" }
   }
   ```

2. **Legacy array form:** a bare list of URIs with no tool mapping.

   ```jsonc
   "capabilities": ["org.kyapay:kya"]
   ```

   For the array form, KYA detection still works but the tool name defaults to
   `create-kya-token` (see [kyaCapabilityTool](../packages/opencode/src/mcp/kya.ts#L31-L41)),
   and the **payment gateway ignores array-form entries entirely** because they
   carry no tool name ([buildCapabilityMap](../packages/opencode/src/mcp/gateway.ts#L231)).

The `Capability` struct's `tool` field is `optional` in the schema
([Capability](../packages/opencode/src/config/mcp.ts#L46-L51)); a record entry
without a `tool` can't mint and is skipped by the gateway.

### 4.3 Example wallet config (`.opencode/opencode.jsonc`)

```jsonc
{
  "mcp": {
    "merchant": {
      "type": "remote",
      "url": "https://merchant.example.com/mcp",
    },
    "skyfire": {
      "type": "remote",
      "url": "http://mcp.skyfire.xyz/mcp",
      "capabilities": {
        "org.kyapay:kya": { "tool": "create-kya-token" },
        "org.kyapay:pay": { "tool": "create-pay-token" },
      },
      "headers": {
        "skyfire-api-key": "{env:SKYFIRE_API_KEY}",
      },
    },
  },
}
```

The issuer (`skyfire`) authenticates itself via its `skyfire-api-key` header. It
is **never** subjected to the KYA preflight (you don't mint a KYA token to talk
to the KYA issuer). See §7.1.

> **Security:** API keys must never be committed. Use `{env:SKYFIRE_API_KEY}`
> interpolation and export the secret at runtime.

---

## 5. Capability Model & Issuer Selection

### 5.1 Detecting the KYA capability

[hasKyaCapability](../packages/opencode/src/mcp/kya.ts#L13-L17) returns true when an
entry's `capabilities` either:

- (record form) contains the key `org.kyapay:kya`, or
- (array form) includes the string `"org.kyapay:kya"`.

`KYA_CAPABILITY = "org.kyapay:kya"` is the single source of truth
([kya.ts#L4](../packages/opencode/src/mcp/kya.ts#L4)).

### 5.2 Selecting the issuer

[kyaIssuerFromConfig](../packages/opencode/src/mcp/kya.ts#L20-L29) scans the whole
`mcp` config and returns the **first remote server** that (a) advertises the KYA
capability and (b) resolves to a non-empty tool name. The return shape:

```ts
type KyaIssuer = { name: string; config: ConfigMCP.Remote; tool: string }
```

Key properties:

- **Selection is by capability, not by server name.** The example server is
  named `skyfire` but any name works.
- **Tool resolution** ([kyaCapabilityTool](../packages/opencode/src/mcp/kya.ts#L31-L41)):
  record form uses `capabilities["org.kyapay:kya"].tool` (trimmed); array form
  defaults to `"create-kya-token"`. If the record form has an empty/missing
  tool, that server is **not** treated as an issuer.
- **First match wins** — if multiple servers advertise KYA, ordering of
  `Object.entries(config.mcp)` decides.

### 5.3 The capability map (for payments)

[buildCapabilityMap](../packages/opencode/src/mcp/gateway.ts#L223-L239) builds a
`{ [capabilityURI]: { server, tool } }` map across **all** configured servers,
record form only. This drives both:

- **Payment routing** (§12), and
- **Provider hiding** in [MCP.tools](../packages/opencode/src/mcp/index.ts#L1086-L1135):
  any server that appears as a capability provider is excluded from the toolset
  exposed to the LLM, so the model cannot call `create-pay-token` /
  `create-kya-token` directly and bypass the gateway
  ([index.ts#L1096-L1104](../packages/opencode/src/mcp/index.ts#L1096-L1104)).

---

## 6. Connection Lifecycle & Status Model

### 6.1 Status values

[Status](../packages/opencode/src/mcp/index.ts#L106-L114) is a discriminated union:

| Status                      | Meaning                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `connected`                 | Client connected, tools listed and cached.                                            |
| `disabled`                  | `enabled: false`, or explicitly disconnected.                                         |
| `not_connected`             | Configured but never connected this session.                                          |
| `needs_auth`                | Auth required; interactive OAuth available (KYA not advertised, or fallback enabled). |
| `needs_client_registration` | Server requires a pre-registered client; DCR unsupported.                             |
| `failed`                    | Connection or KYA minting failed; carries an `error` string.                          |

### 6.2 Connections are lazy

The service does **not** eagerly connect servers at startup
([MCP.state](../packages/opencode/src/mcp/index.ts#L924-L962)). A connection (and
any KYA it triggers) happens on-demand via `MCP.connect(name)` when the user
enables a server in the UI / CLI / API.

### 6.3 Two entry points into KYA

There are **two** places the silent KYA flow can run, and they must produce the
same B→C→D behavior:

1. **`MCP.connect` preflight** ([index.ts#L1036-L1076](../packages/opencode/src/mcp/index.ts#L1036-L1076)) —
   runs `trySilentKya` _up front_, before attempting transport connect, for any
   remote server that is not itself the issuer. If KYA is advertised but minting
   fails, it sets `failed` and stops (no interactive fallback in the demo
   default).

2. **`connectRemote` 401 catch handler** ([index.ts#L732-L782](../packages/opencode/src/mcp/index.ts#L732-L782)) —
   the auto-connect path (e.g. when `createAndStore` runs without the preflight)
   catches the `UnauthorizedError` from the StreamableHTTP attempt and _then_
   runs `trySilentKya`, retrying the transport on success.

Both call the identical [trySilentKya](../packages/opencode/src/mcp/index.ts#L188-L437).

### 6.4 Transport selection

`connectRemote` tries **StreamableHTTP first, then SSE**
([index.ts#L669-L684](../packages/opencode/src/mcp/index.ts#L669-L684)). Important
nuances:

- A 401 on the StreamableHTTP attempt sets `stopTransportFallback = true`
  ([index.ts#L714](../packages/opencode/src/mcp/index.ts#L714)) — the server clearly
  speaks HTTP and just needs auth, so we **never** fall back to SSE (which would
  404 and mask the real auth/KYA failure).
- KYA minting is only attempted on the **StreamableHTTP** branch and only once
  (`!kyaRetried`) and only when the server is not the issuer (`!hasKyaCapability(mcp)`)
  ([index.ts#L735](../packages/opencode/src/mcp/index.ts#L735)).
- A transport cannot be reused after a failed connect, so the post-KYA retry
  builds a **fresh** StreamableHTTP transport
  ([freshStreamable](../packages/opencode/src/mcp/index.ts#L697-L701)); the auth
  provider's `tokens()` now returns the token `trySilentKya` just stored.

---

## 7. The Silent KYA Flow (`trySilentKya`)

[trySilentKya](../packages/opencode/src/mcp/index.ts#L188-L437) is an Effect that
returns a `KyaMintResult`:

```ts
type KyaMintResult =
  | { minted: true; kyaAdvertised: true } // success
  | { minted: false; kyaAdvertised: false } // KYA not advertised → caller may fall back
  | { minted: false; kyaAdvertised: true; error: string } // KYA advertised but minting failed → hard fail
```

The `kyaAdvertised` flag drives the gating logic (§9): it tells the caller
whether a failure should hard-fail or fall through to interactive OAuth.

### 7.1 Issuer self-exclusion

Before any KYA work, callers check `!hasKyaCapability(mcp)`. The issuer
authenticates via its own configured headers (`skyfire-api-key`), so it must
never be put through the KYA preflight. Otherwise OpenCode would try to mint a
KYA token just to reach the KYA minter, a chicken-and-egg deadlock. See
[connect](../packages/opencode/src/mcp/index.ts#L1039-L1041) and
[connectRemote](../packages/opencode/src/mcp/index.ts#L735).

### 7.2 Phase B — Discovery & advertisement gate

[index.ts#L214-L264](../packages/opencode/src/mcp/index.ts#L214-L264):

1. **B1–B2 probe.** [probeResourceMetadataUrl](../packages/opencode/src/mcp/kya.ts#L60-L74)
   does `POST <serverUrl>` with a minimal JSON-RPC `initialize` body and no
   `Authorization`. If the response is `401`, it reads the
   `resource_metadata="…"` pointer from the `WWW-Authenticate` header (RFC 9728).
   If there's no 401 or no pointer, it returns `undefined` and the caller falls
   back to the default well-known location:
   `<origin>/.well-known/oauth-protected-resource`.

2. **B3–B4 protected-resource metadata.** `GET` the resource-metadata URL. The
   response is expected to contain:
   - `authorization_servers: string[]` → the Resource AS origin (`authServers[0]`).
   - optionally `seller_service_id` → a seller identity the resource advertises
     for itself ([index.ts#L233-L235](../packages/opencode/src/mcp/index.ts#L233-L235)).
     If there's no auth server, `supportsKya: false` and the flow short-circuits.

3. **B5–B6 AS metadata.** `GET <authServer>/.well-known/oauth-authorization-server`
   (RFC 8414), falling back to `/.well-known/openid-configuration`. From the
   metadata we read `authorization_grant_profiles_supported` and check whether it
   advertises the KYA profile via
   [authorizationGrantProfilesSupported](../packages/opencode/src/mcp/index.ts#L142-L154)
   (which normalizes both the full URN
   `urn:ietf:params:oauth:grant-profile:kya` and the short token `kya`).

**The advertisement gate:** if `profiles` does not include `kya`,
`supportsKya` is false and `trySilentKya` returns
`{ minted: false, kyaAdvertised: false }` — KYA is skipped and the caller may
fall back to interactive OAuth ([index.ts#L266-L269](../packages/opencode/src/mcp/index.ts#L266-L269)).
Once we pass this gate, the internal `advertised` flag is set to `true`
([index.ts#L270](../packages/opencode/src/mcp/index.ts#L270)), which guarantees any
_subsequent_ thrown failure is reported as `kyaAdvertised: true` (see §7.6).

> All of Phase B is wrapped in a `try/catch` that resolves to
> `{ supportsKya: false }` on error ([index.ts#L263](../packages/opencode/src/mcp/index.ts#L263)),
> so a discovery/network failure degrades to "KYA not advertised," not a hard
> error.

### 7.3 Seller selector resolution

[index.ts#L272-L282](../packages/opencode/src/mcp/index.ts#L272-L282). Priority:

1. **`OPENCODE_KYA_SELLER_SERVICE_ID`** env override → `{ sellerServiceId }`.
2. **`seller_service_id`** advertised by the protected-resource metadata → `{ sellerServiceId }`.
3. **Derived from the target MCP URL** → `{ sellerDomainOrUrl }`, via
   [kyaSellerDomainOrUrl](../packages/opencode/src/mcp/index.ts#L161-L180): the
   target's hostname, except **loopback / RFC 1918 private ranges** are
   substituted with the placeholder `mcp-server.com` (because Skyfire's seller
   directory can't resolve localhost). The recognized "local" set: `localhost`,
   `127.0.0.1`, `::1`, `0.0.0.0`, `*.localhost`, `127.*`, `10.*`, `192.168.*`,
   `172.16–31.*`.

The Skyfire `create-kya-token` tool requires **exactly one** seller selector.

### 7.4 Phase C — Mint the KYA assertion

[index.ts#L284-L348](../packages/opencode/src/mcp/index.ts#L284-L348):

1. If `args.issuer` is undefined → return
   `{ minted: false, kyaAdvertised: true, error: "KYA supported but no issuer configured…" }`.
2. Connect to the issuer via a `StreamableHTTPClientTransport` carrying
   `issuer.config.headers` (the `skyfire-api-key`)
   ([index.ts#L302-L310](../packages/opencode/src/mcp/index.ts#L302-L310)).
3. `callTool({ name: issuer.tool, arguments: sellerArg })`, with the client
   closed afterward via `Effect.ensuring`
   ([index.ts#L320-L323](../packages/opencode/src/mcp/index.ts#L320-L323)).
4. Concatenate the text content of the result and extract the JWT with
   [extractJwtFromText](../packages/opencode/src/mcp/kya.ts#L48-L51) — a regex
   matching a three-segment `xxx.yyy.zzz` token. (The Skyfire tool currently
   returns a human-readable string like
   `"Creation of KYA token for <id> is complete: <jwt>"`.) No JWT → error result.

### 7.5 Phase D — Exchange & store

[index.ts#L350-L420](../packages/opencode/src/mcp/index.ts#L350-L420):

1. **Re-fetch the AS metadata for the `token_endpoint`**
   ([index.ts#L350-L372](../packages/opencode/src/mcp/index.ts#L350-L372)). Missing
   `token_endpoint` → error result.

   > **Why re-fetch?** Phase B (§7.2) already fetched the same AS metadata, but it
   > only kept `supportsKya` and the `authServer` origin from it, not the
   > `token_endpoint`. Phase D re-fetches `<authServer>/.well-known/oauth-authorization-server`
   > to read `token_endpoint`. The two phases don't share the parsed metadata
   > object, so this is a redundant round-trip: harmless, but visible when you
   > trace network calls.

2. `POST <token_endpoint>` with
   `content-type: application/x-www-form-urlencoded` and body:

   ```
   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
   assertion=<kya_jwt>
   ```

   A non-2xx throws `OAuth token exchange failed (<status>): <body>`
   ([index.ts#L381-L392](../packages/opencode/src/mcp/index.ts#L381-L392)).

   > **The exchange is client-unauthenticated.** The request carries _only_
   > `grant_type` and `assertion` — there is **no** `client_id`/`client_secret`, no
   > `Authorization` header, and **no `scope` parameter**. All trust derives from
   > the issuer-signed assertion; the AS is responsible for validating its
   > signature, issuer, expiry, and replay (`jti`). Because no scope is requested,
   > the AS assigns a default scope (the mock uses `mcp`).

3. Read **`access_token`** from the JSON response. Missing → error result.

   > **The rest of the token response is discarded.** Even though the AS returns
   > `expires_in`, `scope`, and possibly `refresh_token`, the silent path persists
   > only the access token —
   > `{ accessToken, refreshToken: undefined, expiresAt: undefined, scope: undefined }`
   > ([index.ts#L409-L413](../packages/opencode/src/mcp/index.ts#L409-L413)). See
   > §7.7 for the consequences (no local expiry tracking, no refresh).

4. Persist via
   [auth.updateTokens(name, { accessToken }, origin)](../packages/opencode/src/mcp/index.ts#L409-L413).
   **The token is keyed by the server's URL origin**, matching the normalization
   the OAuth provider does (§8.1), so a later `tokens()` lookup finds it.
5. Return `{ minted: true, kyaAdvertised: true }`.

> **Two implementations of the exchange exist.** The silent connect path above is
> an **inline** copy inside `trySilentKya`. A second, _standalone_ implementation
> lives in [exchangeAssertionForAccessToken](../packages/opencode/src/mcp/kya.ts#L122-L137)
> (plus [discoverResourceAuthServer](../packages/opencode/src/mcp/kya.ts#L82-L116))
> and is used **only** by the CLI `mcp debug` command (§14.3). The two are parallel
> — they implement the same RFC 7523 request — but they do **not** share code.
> Editing the `kya.ts` helper does **not** change the connect-path behavior, and
> vice versa. Keep them in sync when changing the exchange contract.

### 7.6 Failure semantics & the `advertised` flag

The whole generator is wrapped in `Effect.catch`
([index.ts#L421-L436](../packages/opencode/src/mcp/index.ts#L421-L436)):

- If the `advertised` flag was set (we passed the §7.2 gate), any thrown failure
  (issuer connect, tool call, token exchange) becomes
  `{ minted: false, kyaAdvertised: true, error }`. This is deliberate: a genuine
  KYA failure must **not** silently degrade to interactive OAuth.
- Otherwise → `{ minted: false, kyaAdvertised: false }`.

Both BEGIN/END of the flow are logged with `===== KYA auth flow BEGIN/END =====`
banners ([index.ts#L208](../packages/opencode/src/mcp/index.ts#L208),
[index.ts#L434](../packages/opencode/src/mcp/index.ts#L434)).

### 7.7 Lifetime of a KYA-minted token (no local expiry, no refresh)

Because Phase D stores `expiresAt: undefined` and `refreshToken: undefined`:

- [isTokenExpired](../packages/opencode/src/mcp/auth.ts#L122-L127) returns `false`
  for a KYA-minted token (it returns `false` whenever `expiresAt` is unset), so
  [getAuthStatus](../packages/opencode/src/mcp/index.ts#L1376-L1381) reports
  **`authenticated`** indefinitely — even after the AS-issued `expires_in` has
  actually elapsed.
- OpenCode therefore does **not** proactively re-mint on a timer. A stale token is
  only replaced when the **MCP server rejects it with a 401**, which re-enters the
  connect flow and runs `trySilentKya` again (a fresh mint).
- There is no refresh-token path for KYA tokens; "refresh" is always a full
  re-mint via the issuer.

---

## 8. The OAuth Provider (`McpOAuthProvider`)

[McpOAuthProvider](../packages/opencode/src/mcp/oauth-provider.ts#L30) implements
the MCP SDK's `OAuthClientProvider`. It is used for both the auto-connect
transport and the interactive `startAuth` flow.

### 8.1 URL/origin normalization

The constructor normalizes `serverUrl` to its **origin**
([oauth-provider.ts#L44-L49](../packages/opencode/src/mcp/oauth-provider.ts#L44-L49)).
The SDK treats the provider's server URL as the _origin_ where `/.well-known/*`
lives, but MCP transport URLs often include the `/mcp` path. Normalizing to the
origin ensures (a) discovery doesn't 404 on `/mcp/.well-known/*`, and (b) tokens
stored out-of-band by KYA (keyed by origin) are matched by `getForUrl()` here.

### 8.2 Token & client storage

- `tokens()` ([oauth-provider.ts#L162-L176](../packages/opencode/src/mcp/oauth-provider.ts#L162-L176))
  reads via `auth.getForUrl(name, origin)`. `getForUrl`
  ([auth.ts#L74-L80](../packages/opencode/src/mcp/auth.ts#L74-L80)) returns the
  entry **only if its stored `serverUrl` matches** — preventing token reuse
  across a changed URL.
- `saveTokens()` persists access/refresh/expiry/scope.
- `clientInformation()` ([oauth-provider.ts#L113-L141](../packages/opencode/src/mcp/oauth-provider.ts#L113-L141))
  prefers a configured `clientId`, else a stored dynamically-registered client
  (re-registering if the secret expired).
- `saveClientInformation()` stores DCR results.
- `codeVerifier` / `state` are persisted for PKCE + CSRF. `state()`
  ([oauth-provider.ts#L215-L230](../packages/opencode/src/mcp/oauth-provider.ts#L215-L230))
  is a _generator_: the SDK calls it to both read and mint state, so it creates a
  random 32-byte hex value if none is saved.

### 8.3 Discovery via `WWW-Authenticate`

[ensureDiscoveryViaWwwAuthenticate](../packages/opencode/src/mcp/oauth-provider.ts#L64-L91)
proactively `POST`s to `<origin>/mcp` to provoke a 401, then throws the SDK's
`UnauthorizedError` so the SDK parses the advertised metadata. This avoids a
confusing "Invalid OAuth error response" when an MCP origin returns a plain-text
404 for `/.well-known/*`. It's best-effort and called from `clientInformation()`.

### 8.4 Grant-profile hooks are intentionally inert

`getTokensForMetadata()` and `prepareTokenRequest()`
([oauth-provider.ts#L254-L276](../packages/opencode/src/mcp/oauth-provider.ts#L254-L276))
**return `undefined` by design**. The KYA jwt-bearer exchange is **not** driven
through the SDK's grant-profile hooks; it runs out-of-band in `trySilentKya`,
which discovers, mints, exchanges, and `saveTokens()` _before_ the transport is
retried. Returning `undefined` keeps `trySilentKya` authoritative and lets the
SDK fall back to interactive `authorization_code` when KYA is unavailable.
`getTokensForMetadata` still logs the advertised profiles for diagnostics.

---

## 9. Decision Matrix (Gating Logic)

For an auth-required remote server that is not the issuer, the outcome is:

| KYA advertised? | Issuer configured? | Mint result | `OPENCODE_KYA_INTERACTIVE_FALLBACK` | Outcome                                                 |
| --------------- | ------------------ | ----------- | ----------------------------------- | ------------------------------------------------------- |
| No              | —                  | —           | —                                   | **Interactive OAuth** (`needs_auth`) — always           |
| Yes             | Yes                | success     | —                                   | **Connected** via Bearer                                |
| Yes             | Yes                | failure     | —                                   | **`failed`** (clear KYA error; no fallback)             |
| Yes             | No                 | —           | unset (default)                     | **`failed`** ("KYA supported but no issuer configured") |
| Yes             | No                 | —           | set                                 | **Interactive OAuth** (`needs_auth`)                    |

Where this is enforced:

- **No KYA advertised → fallback:** `trySilentKya` returns
  `kyaAdvertised: false`; the 401 handler proceeds to set `needs_auth`
  ([index.ts#L784-L794](../packages/opencode/src/mcp/index.ts#L784-L794)).
- **KYA advertised, no issuer, default:** short-circuited _before_ calling
  `trySilentKya` in the 401 handler
  ([index.ts#L739-L749](../packages/opencode/src/mcp/index.ts#L739-L749)), set to
  `failed`. The flag flips this to fall through.
- **KYA advertised, mint failed:** `kyaAdvertised: true` →
  `failed` with the mint error
  ([index.ts#L773-L781](../packages/opencode/src/mcp/index.ts#L773-L781), and in the
  preflight [index.ts#L1053-L1072](../packages/opencode/src/mcp/index.ts#L1053-L1072)).

Rationale: in this demo, KYA is the sanctioned non-interactive path. Silently
dropping to a browser prompt when KYA was _supposed_ to work would hide real
failures, so the default is "KYA or bust" with an explicit opt-out flag.

---

## 10. Interactive OAuth Fallback

When the matrix lands on interactive OAuth, the flow is the standard
Authorization Code + PKCE, driven by the SDK + `McpOAuthProvider` + the loopback
callback server.

### 10.1 `startAuth`

[startAuth](../packages/opencode/src/mcp/index.ts#L1213-L1272):

1. Validate the server is remote with OAuth enabled.
2. Resolve the effective redirect URI: `oauth.redirectUri` >
   `http://127.0.0.1:<callbackPort>/mcp/oauth/callback` > default port 19876.
3. Start the loopback callback server
   ([McpOAuthCallback.ensureRunning](../packages/opencode/src/mcp/oauth-callback.ts#L144-L176)).
4. Generate + persist a random `oauthState`.
5. Build a provider whose `onRedirect` captures the authorization URL, attempt a
   transport connect, and on `UnauthorizedError` return the captured
   `authorizationUrl` plus stash the transport in `pendingOAuthTransports`.

### 10.2 `authenticate`

[authenticate](../packages/opencode/src/mcp/index.ts#L1274-L1332):

- If `startAuth` returned **no** URL (already authorized), it lists tools and
  stores the client directly.
- Otherwise it opens the browser
  ([open(result.authorizationUrl)](../packages/opencode/src/mcp/index.ts#L1301)),
  waits for the loopback callback
  ([waitForCallback](../packages/opencode/src/mcp/oauth-callback.ts#L178-L191)),
  **validates the returned state against the stored state** (CSRF defense,
  [index.ts#L1325-L1329](../packages/opencode/src/mcp/index.ts#L1325-L1329)), and
  calls `finishAuth`.
- If the browser can't be opened, it publishes `BrowserOpenFailed` so the CLI can
  print the URL for manual opening
  ([index.ts#L1317-L1320](../packages/opencode/src/mcp/index.ts#L1317-L1320)).

### 10.3 `finishAuth`

[finishAuth](../packages/opencode/src/mcp/index.ts#L1334-L1357): retrieves the
pending transport, calls `transport.finishAuth(code)` (the SDK exchanges the code
at `/token` with the PKCE verifier and stores tokens via the provider), clears
the code verifier, and `createAndStore`s the now-authenticated client.

### 10.4 The callback server

[oauth-callback.ts](../packages/opencode/src/mcp/oauth-callback.ts) is a singleton
`http` server on the redirect port (default 19876). Key behaviors:

- Only the configured `currentPath` is honored; everything else 404s.
- **State is mandatory** — a missing `state` is rejected as a potential CSRF
  attack ([oauth-callback.ts#L92-L99](../packages/opencode/src/mcp/oauth-callback.ts#L92-L99)),
  and an unknown state is rejected
  ([oauth-callback.ts#L121-L131](../packages/opencode/src/mcp/oauth-callback.ts#L121-L131)).
- Pending callbacks are keyed by `oauthState`, with a reverse `mcpName → state`
  index so `cancelPending(mcpName)` can find them. Default timeout: **5 minutes**.
- Serves friendly success/error HTML; the success page auto-closes the tab.

> **Loopback limitation:** the redirect lands on `127.0.0.1:<port>` on the
> **server** host. The interactive flow therefore only completes when the browser
> and instance server share a machine, unless a custom `oauth.redirectUri` is
> configured. The silent KYA flow has no such limitation (no browser).

---

## 11. Token Storage (`McpAuth`)

[McpAuth](../packages/opencode/src/mcp/auth.ts) persists to
`~/.local/share/opencode/mcp-auth.json` with mode `0o600`
([auth.ts#L35](../packages/opencode/src/mcp/auth.ts#L35),
[auth.ts#L85](../packages/opencode/src/mcp/auth.ts#L85)). Each entry
([Entry](../packages/opencode/src/mcp/auth.ts#L23-L30)) holds:

```ts
{ tokens?, clientInfo?, codeVerifier?, oauthState?, serverUrl? }
```

- `tokens` = `{ accessToken, refreshToken?, expiresAt?, scope? }`.
- `serverUrl` is stamped on write and checked by `getForUrl` — the mechanism that
  binds a token to a specific origin and lets the KYA-stored token (keyed by
  origin) be picked up by the provider.
- `isTokenExpired` returns `null` if no token, `false` if no expiry, else
  `expiresAt < now`.

Wipe all stored MCP auth for a clean test:

```sh
rm ~/.local/share/opencode/mcp-auth.json
```

---

## 12. Payment Gateway (`org.kyapay:pay`) — Sibling Feature

The gateway reuses the capability machinery at **tool-call time** to mint
_payment_ tokens. It is wired in via [convertMcpTool](../packages/opencode/src/mcp/index.ts#L472-L515):
when any capability is configured, each tool's `execute` routes through
[executeWithGateway](../packages/opencode/src/mcp/gateway.ts#L261-L445).

Flow ([gateway.ts](../packages/opencode/src/mcp/gateway.ts)):

1. Call the requested tool normally.
2. If the result is an error carrying a `payments/*` signal in `_meta`
   ([parsePaymentSignal](../packages/opencode/src/mcp/gateway.ts#L34-L69)) — settlement
   types, total, currency, optional seller id/search — the gateway intercepts.
3. Match a settlement type to a provider via longest-prefix match against the
   capability map ([findProviderForSettlement](../packages/opencode/src/mcp/gateway.ts#L248-L255)).
4. Resolve the seller id (from the signal or via the issuer's `find-sellers`
   tool — [resolveSellerServiceId](../packages/opencode/src/mcp/gateway.ts#L102-L137)).
5. Call the issuer's pay tool (e.g. `create-pay-token`), forwarding amount/currency
   in `_meta`. If the issuer returns a **mandate** signal
   ([parseMandateSignal](../packages/opencode/src/mcp/gateway.ts#L71-L81)), open the
   mandate URL in a browser and ask the user to retry.
6. Cache the minted token (keyed by settlement type/total/currency, with a 30s
   pre-expiry guard — [token cache](../packages/opencode/src/mcp/gateway.ts#L177-L205)).
7. Retry the original tool with `payments/settlement/token` injected in `_meta`.

The gateway shares the issuer-hiding rule (§5.3): provider servers are excluded
from the LLM-visible toolset so the model can't call the mint tools directly.

> **KYA vs. pay:** KYA mints an _auth_ assertion to _connect_ to a server; pay
> mints a _payment_ token to _settle a transaction_ with an already-connected
> server. Both go through the same configured issuer; only the capability URI and
> tool differ.

---

## 13. Environment Flags

Defined in [flag.ts](../packages/core/src/flag/flag.ts), evaluated at access time:

| Flag                                | Effect                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCODE_KYA_SELLER_SERVICE_ID`    | Pins the seller selector to a specific `sellerServiceId` UUID, overriding URL-derived selection ([flag.ts#L79-L81](../packages/core/src/flag/flag.ts#L79-L81)).                                                                                                                                                                                   |
| `OPENCODE_KYA_INTERACTIVE_FALLBACK` | When set, an auth-required server that advertises KYA but has **no configured issuer** falls through to interactive OAuth instead of hard-failing ([flag.ts#L85-L87](../packages/core/src/flag/flag.ts#L85-L87)). Does **not** affect the "no KYA advertised" case (which always falls back) or the "mint failed" case (which always hard-fails). |

`truthy()` accepts `"1"` or `"true"` (case-insensitive).

---

## 14. Entry Points

### 14.1 Web UI

[dialog-select-mcp.tsx](../packages/app/src/components/dialog-select-mcp.tsx) and
[status-popover-body.tsx](../packages/app/src/components/status-popover-body.tsx)
toggle servers. On toggle:

- `connected` → `mcp.disconnect({ name })`.
- `needs_auth` → `mcp.auth.authenticate({ name })` — drives the **interactive**
  flow (opens browser on the server host; see §10.4 loopback caveat).
- otherwise → `mcp.connect({ name })` — triggers the KYA preflight.

### 14.2 HTTP API

```bash
# Connect (runs the KYA preflight)
curl -sS -X POST 'http://localhost:4096/mcp/<name>/connect?directory=<urlenc>'
# Status
curl -sS 'http://localhost:4096/mcp?directory=<urlenc>'
```

### 14.3 CLI

[cli/cmd/mcp.ts](../packages/opencode/src/cli/cmd/mcp.ts):

- `opencode mcp list` — servers + status.
- `opencode mcp auth [name]` — interactive OAuth (`authenticate`).
- `opencode mcp logout [name]` — `removeAuth`.
- `opencode mcp add` — config wizard.
- `opencode mcp debug <name>` — a standalone diagnostic that probes the server,
  and on 401 runs a CLI-local KYA mint
  ([mintKyaAccessToken](../packages/opencode/src/cli/cmd/mcp.ts#L135-L195)) using the
  `kya.ts` helpers (`discoverResourceAuthServer` + `exchangeAssertionForAccessToken`),
  stores the token, then proves it by reconnecting and listing tools.

---

## 15. Mock Server Reference

[mock-mcp-kya-server.ts](../packages/opencode/script/mock-mcp-kya-server.ts) runs
two HTTP servers for local end-to-end testing:

| Server            | Port | Endpoints                                                                                                                                                                                                            |
| ----------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mock MCP**      | 8787 | `GET /.well-known/oauth-protected-resource` (→ AS on 8788), `POST /mcp` (Bearer-protected JSON-RPC: `initialize`, `tools/list` [`echo`, `add`], `tools/call`).                                                       |
| **Mock OAuth AS** | 8788 | `GET /.well-known/oauth-authorization-server` & `/openid-configuration`, `GET /authorize` (auto-approving, PKCE), `POST /register` (DCR), `POST /token` (jwt-bearer **and** authorization_code), `POST /introspect`. |

Notable behaviors:

- **`MOCK_DISABLE_KYA=1`** drops `kya` from `authorization_grant_profiles_supported`
  and `jwt-bearer` from `grant_types_supported`
  ([mock#L62-L86](../packages/opencode/script/mock-mcp-kya-server.ts#L62-L86)), turning
  the AS into a plain OAuth server. That's how you exercise the interactive fallback.
- The AS **verifies the KYA assertion's signature** against the real Skyfire QA
  JWKS (`https://app-qa.skyfire.xyz/.well-known/jwks.json`) and `iss`
  ([verifyKyaAssertion](../packages/opencode/script/mock-mcp-kya-server.ts#L129-L151)),
  rejects replayed `jti`s
  ([checkAndRememberAssertionJti](../packages/opencode/script/mock-mcp-kya-server.ts#L153-L168)),
  and requires `aid`/`hid` claims.
- The issued access token's `aud` is set to the MCP resource URI; the mock MCP
  validates signature + `iss` + `aud` + `sub` + `exp` + `scope` before serving
  ([mock#L554](../packages/opencode/script/mock-mcp-kya-server.ts#L554)).
- The 401 challenge advertises the AS metadata via
  `WWW-Authenticate: Bearer realm="mcp", authorization-uri="…/.well-known/oauth-authorization-server"`.

---

## 16. End-to-End Sequence

```mermaid
sequenceDiagram
    autonumber
    participant A as Agent (OpenCode)
    participant M as MCP server (resource)
    participant AS as Resource AS (OAuth)
    participant I as KYA Issuer (Skyfire)

    Note over A: connect(name)

    alt server advertises org.kyapay:kya (it IS the issuer)
        A->>M: connect with configured headers (skyfire-api-key)
        Note over A,M: KYA preflight skipped — issuer authenticates itself
    else normal remote server (trySilentKya)
        Note over A,AS: Phase B — discovery
        A->>M: POST /mcp (no Authorization) [B1]
        M-->>A: 401 WWW-Authenticate, resource_metadata=… [B2]
        A->>M: GET /.well-known/oauth-protected-resource [B3]
        M-->>A: { authorization_servers:[AS], seller_service_id? } [B4]
        A->>AS: GET /.well-known/oauth-authorization-server [B5]
        AS-->>A: { token_endpoint, authorization_grant_profiles_supported } [B6]

        alt KYA advertised AND issuer configured
            Note over A,I: Phase C — mint KYA assertion
            A->>I: connect + tools/call <kya tool> (seller selector) [C1]
            I-->>A: KYA JWT assertion [C2]
            Note over A,AS: Phase D — exchange + use
            A->>AS: POST /token grant_type=jwt-bearer & assertion=<JWT> [D1]
            AS->>I: fetch JWKS, verify assertion signature
            AS-->>A: { access_token (aud = MCP) } [D2]
            A->>M: POST /mcp + Authorization: Bearer <access_token> [D3]
            M-->>A: 200 OK + tools — connected [D4]
        else KYA advertised, NO issuer configured
            alt OPENCODE_KYA_INTERACTIVE_FALLBACK=1
                Note over A: fall through to interactive (below)
            else default
                Note over A: status = failed ("no issuer configured")
            end
        else KYA not advertised (or fallback enabled)
            Note over A,AS: Interactive Authorization Code + PKCE
            A->>AS: GET /authorize?response_type=code&code_challenge=… (browser)
            AS-->>A: 302 → redirect_uri?code=… (loopback callback :19876)
            A->>AS: POST /token grant_type=authorization_code & code_verifier
            AS-->>A: { access_token }
            A->>M: POST /mcp + Authorization: Bearer <access_token>
            M-->>A: 200 OK + tools — connected
        end
    end
```

---

## 17. Error Handling & Edge Cases

| Situation                            | Behavior                                            | Code                                                                                  |
| ------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Invalid MCP URL                      | `failed` immediately                                | [remoteURL](../packages/opencode/src/mcp/index.ts#L131-L134)                          |
| Discovery/network error in Phase B   | Treated as "KYA not advertised" → fallback eligible | [index.ts#L263](../packages/opencode/src/mcp/index.ts#L263)                           |
| KYA advertised, no issuer (default)  | `failed` with actionable message                    | [index.ts#L739-L749](../packages/opencode/src/mcp/index.ts#L739-L749)                 |
| Issuer returns non-JWT text          | `failed` "Could not extract JWT assertion…"         | [index.ts#L336-L342](../packages/opencode/src/mcp/index.ts#L336-L342)                 |
| AS metadata missing `token_endpoint` | `failed`                                            | [index.ts#L366-L372](../packages/opencode/src/mcp/index.ts#L366-L372)                 |
| Token exchange non-2xx               | `failed` with status + body                         | [index.ts#L388](../packages/opencode/src/mcp/index.ts#L388)                           |
| 401 on StreamableHTTP                | No SSE fallback; auth path only                     | [stopTransportFallback](../packages/opencode/src/mcp/index.ts#L714)                   |
| Server needs pre-registered client   | `needs_client_registration`                         | [index.ts#L716-L730](../packages/opencode/src/mcp/index.ts#L716-L730)                 |
| Interactive: missing/invalid state   | Callback rejected (CSRF)                            | [oauth-callback.ts#L92-L131](../packages/opencode/src/mcp/oauth-callback.ts#L92-L131) |
| Interactive: state mismatch          | Throw "OAuth state mismatch"                        | [index.ts#L1326-L1329](../packages/opencode/src/mcp/index.ts#L1326-L1329)             |
| Browser won't open                   | Publish `BrowserOpenFailed`; CLI prints URL         | [index.ts#L1317-L1320](../packages/opencode/src/mcp/index.ts#L1317-L1320)             |
| Callback timeout                     | Reject after 5 min                                  | [oauth-callback.ts#L65](../packages/opencode/src/mcp/oauth-callback.ts#L65)           |
| Token bound to wrong origin          | `getForUrl` returns undefined → re-auth             | [auth.ts#L74-L80](../packages/opencode/src/mcp/auth.ts#L74-L80)                       |

---

## 18. Security Considerations

- **No secrets in the repo.** The issuer's `skyfire-api-key` is supplied via
  `{env:…}` interpolation; tokens are stored at mode `0o600` outside the repo.
- **CSRF.** Interactive OAuth enforces `state` both at the callback server and
  again in `authenticate` (the stored value must match the returned one).
- **PKCE.** The interactive flow uses `S256` code challenges; the mock enforces
  verification.
- **Audience binding.** The AS sets the access token's `aud` to the MCP
  resource's canonical URI; the resource validates it as a plain OAuth resource
  server. A token minted for resource X cannot be replayed against resource Y.
- **Origin binding of stored tokens.** `getForUrl` prevents a token saved for one
  origin from being presented to another.
- **Replay protection.** The (mock) AS tracks KYA assertion `jti`s and rejects
  duplicates, modeling the recommended issuer behavior.
- **No silent downgrade.** When KYA is advertised, a mint failure surfaces as a
  hard error rather than quietly prompting a human — preventing a downgrade
  attack/confusion where a failing agent flow becomes an interactive one.
- **Issuer tool hiding.** Capability-provider servers' tools are withheld from the
  LLM toolset so the model can't mint tokens directly and bypass the gateway.

---

## 19. Testing

- **Silent KYA (default):** run the mock without `MOCK_DISABLE_KYA`, configure
  `merchant-mcp` + a KYA issuer, connect → expect `connected` with no browser.
- **Interactive fallback:** run the mock with `MOCK_DISABLE_KYA=1`, configure only
  `merchant-mcp` (no issuer) → connect yields `needs_auth`; complete via
  `opencode mcp auth merchant-mcp`. (No flag needed because KYA isn't advertised.)
- **"KYA advertised, no issuer" fallback:** run the mock _with_ KYA, omit the
  issuer, set `OPENCODE_KYA_INTERACTIVE_FALLBACK=1` → falls through to interactive
  instead of failing.
- **Diagnostics:** `opencode mcp debug <name>` mints + proves a token end to end.
- Full runbook, log markers, and one-command demo (`bun run demo:kya`) are in
  [KYA.md](KYA.md).

---

## 20. Known Limitations

- **Interactive flow is local-only by default.** The loopback redirect lands on
  the server host. A truly remote web app needs the split
  `mcp.auth.start` → open-in-user-browser → `mcp.auth.callback` flow with an
  app-hosted redirect.
- **Issuer output parsing is regex-based.** `extractJwtFromText` scrapes a JWT out
  of a human-readable string. A structured tool result would be more robust.
- **First-issuer-wins.** Multiple KYA issuers aren't disambiguated beyond config
  order.
- **No local expiry tracking or refresh for KYA-minted tokens.** `trySilentKya`
  stores only the access token (`expiresAt`/`refreshToken`/`scope` are dropped), so
  the token reads as `authenticated` indefinitely and is **not** re-minted on a
  timer — a fresh mint happens only when the MCP server rejects the stale token
  with a 401. See §7.7.
- **Demo seller placeholder.** Loopback/private targets are mapped to
  `mcp-server.com`; real deployments must register their domain (or use
  `OPENCODE_KYA_SELLER_SERVICE_ID`) in the Skyfire seller directory.

```

```
