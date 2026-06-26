# KYA + OAuth + MCP Integration — Technical Specification

How an autonomous agent authenticates to a protected MCP server by exchanging a
**KYA (Know Your Agent) assertion** for an OAuth access token, what that assertion
contains, and **which fields the Authorization Server validates** before minting the
token. It also covers when the agent falls back to interactive OAuth and how the same
machinery mints payment tokens (`org.kyapay:pay`). The doc is independent of any
particular client implementation.

The heart of the integration is the **KYA → OAuth token exchange**: how the assertion
is minted, the RFC 7523 jwt-bearer request that exchanges it, and the per-field
validation the AS performs. The assertion-validation algorithm follows the issuer's
published KYA token-verification reference.

---

## 1. Purpose & Background

MCP (Model Context Protocol) remote servers are HTTP resources that may require
OAuth 2.1 authorization. The standard flow for an unauthenticated server is the
interactive **Authorization Code + PKCE** flow: open a browser, the user
consents, an authorization code returns to the client's redirect URI, and the code is
exchanged for an access token.

That flow assumes a _human_ is present to consent. An autonomous agent has no
browser session to drive, so it needs a **non-interactive** way to obtain an
access token in which the **agent's identity** (not a human's browser session)
is what the resource server authorizes. That is what **KYA** provides:

1. A trusted **issuer** — a dedicated MCP server — mints a signed **KYA assertion**
   (a JWT) attesting to the agent's identity and the seller it wants to act against.
2. The agent exchanges that assertion at the resource's **Authorization Server**
   (AS) for a normal OAuth access token, using RFC 7523's
   `urn:ietf:params:oauth:grant-type:jwt-bearer` grant.
3. The agent uses that access token as a plain `Bearer` credential against the
   MCP server, which validates it as an ordinary OAuth 2.1 resource server with
   **no KYA awareness**.

KYA is therefore a _non-interactive optimization layered on top of standard
OAuth_. When a server doesn't advertise KYA (or KYA minting can't be performed),
the agent falls back to the interactive flow.

The same "configured capability → issuer MCP tool" machinery is reused at
**tool-call time** to mint _payment_ tokens (`org.kyapay:pay`) mid-conversation.
That sibling feature is documented in the Payment Capability section.

---

## 2. Terminology & Actors

| Term                      | Meaning                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent**                 | The autonomous MCP client that connects to remote MCP servers on a user's behalf.                                                                                                      |
| **MCP server / Resource** | The protected remote MCP server the agent wants to use. A plain OAuth 2.1 resource server.                                                                                             |
| **Resource AS**           | The OAuth Authorization Server protecting the resource. Hosts discovery metadata + the `/token` endpoint.                                                                              |
| **KYA Issuer**            | A remote MCP server advertising capability `org.kyapay:kya` and exposing a tool (e.g. `create-kya-token`) that mints KYA assertions. |
| **KYA assertion**         | A signed JWT minted by the issuer, attesting agent identity + seller. _Not_ an OAuth access token.                                                                                     |
| **Access token**          | A normal OAuth 2.1 Bearer token issued by the Resource AS in exchange for the assertion.                                                                                               |
| **Capability**            | A URI like `org.kyapay:kya` or `org.kyapay:pay` declared in config, mapped to the issuer tool that fulfills it.                                                                        |
| **Seller selector**       | The argument passed to the issuer tool identifying the seller: either `sellerServiceId` (a UUID) or `sellerDomainOrUrl` (a hostname).                                                  |

**Relevant RFCs / specs:**

- **RFC 9728** — OAuth 2.0 Protected Resource Metadata (`/.well-known/oauth-protected-resource`).
- **RFC 8414** — OAuth 2.0 Authorization Server Metadata (`/.well-known/oauth-authorization-server`).
- **RFC 7523** — JWT Profile for OAuth Client Authentication and Authorization Grants (`grant_type=…:jwt-bearer`).
- **RFC 8693** — OAuth 2.0 Token Exchange (`act`/`may_act` delegation; the model the KYA exchange is closest to — see the standards & hardening section).
- **RFC 8707** — Resource Indicators (the `resource` parameter that binds the issued token's audience).
- **RFC 9068** — JWT Profile for OAuth 2.0 Access Tokens (`typ: at+jwt`; the issued access token's shape).
- **RFC 6750** — Bearer Token Usage (the `WWW-Authenticate` challenge and `401`/`403` semantics).
- **RFC 8725** — JSON Web Token Best Current Practices (algorithm allow-listing, explicit typing).
- **RFC 9700** — OAuth 2.0 Security Best Current Practice.
- **RFC 7662 / RFC 7009** — Token Introspection / Token Revocation (optional, see the standards & hardening section).
- **RFC 7591** — OAuth 2.0 Dynamic Client Registration (used only in the interactive fallback).
- **RFC 7636** — PKCE (interactive fallback).

> **Standards status (read before implementing).** The grant-profile discovery field
> `authorization_grant_profiles_supported`, the profile URN
> `urn:ietf:params:oauth:grant-profile:kya`, and the assertion media type `kya+jwt`
> are **not currently IANA-registered IETF values** — treat them as vendor/experimental
> identifiers in a namespace that may change. This profile also **relaxes RFC 7523**:
> RFC 7523 requires the assertion's `aud` to be the AS itself, whereas here `aud`
> carries the seller identity (*Mint the KYA assertion*) and the AS-side seller binding uses `sdm`/`ssi`
> instead. Functionally the exchange is closer to **RFC 8693 token exchange** (an
> identity assertion swapped for a resource-scoped token for a delegated actor) and to
> the IETF "identity chaining / ID-JAG" drafts. The final section (*Standards Status,
> Delegation & Productionization*) records the standards-conformance
> and delegation gaps a general-purpose IdP must close before treating this as
> production-grade.

The flow has three steps: **discovery** (find the Resource AS and read its grant
profiles), **mint** (create the KYA assertion at the issuer), and **exchange** (swap
the assertion for an access token and use it).

---

## 3. Architecture Overview

Three network parties cooperate, with the agent orchestrating:

- The **agent** holds configuration for both the target MCP server(s) and the KYA
  issuer, owns the connection lifecycle, and performs discovery, minting, and the
  token exchange.
- The **Resource AS** publishes discovery metadata (whether it supports KYA) and
  exchanges a KYA assertion for an access token.
- The **KYA issuer** mints assertions on request, authenticated by the agent's
  issuer credential (e.g. an API key).

### 3.1 High-level data flow

```
   user action ─▶ connect(server)
                       │
                       ▼ (401 / Unauthorized)
                 silent KYA flow ──── discovery ───────────────┐
                       │                                      ▼
                       │                             Resource AS metadata
                       ▼ mint
                 KYA Issuer ── create-kya-token ─▶ KYA JWT assertion
                       ▼ exchange
                 Resource AS /token (jwt-bearer) ─▶ access_token
                       ▼
                 persist token (keyed by resource origin)
                       ▼
                 retry transport w/ Bearer ─▶ connected
```

The agent never calls the issuer's REST APIs directly; minting always goes
through an **MCP tool call** on the issuer server. This keeps the issuer's
credential (the API key) on the issuer connection only.

---

## 4. Configuration Model

### 4.1 Remote server entry

A remote MCP entry describes how to reach a server and (optionally) how it
authenticates:

```jsonc
{
  "type": "remote",
  "url": "https://merchant.example.com/mcp",
  "transport": "streamable_http",      // optional: "streamable_http" | "sse"
  "enabled": true,                      // optional
  "headers": { "x-custom": "…" },       // optional, sent on every request
  "oauth": { /* … */ } | false,         // optional; false disables OAuth auto-detect
  "timeout": 30000,                     // optional, ms
  "capabilities": { /* … */ }           // optional; see the Capability Model
}
```

Optional OAuth sub-config (used by the interactive fallback):

```jsonc
"oauth": {
  "clientId": "…",        // pre-registered client; skips dynamic registration
  "clientSecret": "…",
  "scope": "…",
  "callbackPort": 19876,  // shorthand for redirectUri port
  "redirectUri": "http://<client-host>:19876/mcp/oauth/callback"
}
```

### 4.2 The `capabilities` schema

`capabilities` maps a capability URI to the issuer tool that fulfills it:

```jsonc
"capabilities": {
  "org.kyapay:kya": { "tool": "create-kya-token" },
  "org.kyapay:pay": { "tool": "create-pay-token" }
}
```

The `tool` value names the MCP tool on that server which mints the token for the
capability. A capability entry without a usable `tool` cannot mint and is
ignored.

### 4.3 Example configuration

```jsonc
{
  "mcp": {
    "merchant": {
      "type": "remote",
      "url": "https://merchant.example.com/mcp",
    },
    "issuer": {
      "type": "remote",
      "url": "https://mcp.issuer.example/mcp",
      "capabilities": {
        "org.kyapay:kya": { "tool": "create-kya-token" },
        "org.kyapay:pay": { "tool": "create-pay-token" },
      },
      "headers": {
        "issuer-api-key": "{env:ISSUER_API_KEY}",
      },
    },
  },
}
```

The issuer server authenticates itself via its `issuer-api-key` header. It never
enters the KYA branch — you don't mint a KYA token to talk to the KYA issuer.

> **Security:** API keys must never be stored in plaintext configuration. Use
> environment interpolation (e.g. `{env:ISSUER_API_KEY}`) and supply the secret at
> runtime.

---

## 5. Capability Model & Issuer Selection

### 5.1 Detecting the KYA capability

A server is KYA-capable when its `capabilities` map contains the key
`org.kyapay:kya`. `org.kyapay:kya` is the single capability URI used for KYA
issuance.

### 5.2 Selecting the issuer

The agent scans its whole MCP config and selects the **first remote server**
that (a) advertises the KYA capability and (b) resolves to a non-empty tool name.
An issuer is identified by `{ name, config, tool }`.

Key properties:

- **Selection is by capability, not by server name.** The example server is named
  `issuer`, but any name works.
- **Tool resolution** uses `capabilities["org.kyapay:kya"].tool`. If that is
  empty or missing, the server is **not** treated as an issuer.
- **First match wins** — if multiple servers advertise KYA, configuration order
  decides.

### 5.3 The capability map (for payments) and issuer hiding

A capability map `{ [capabilityURI]: { server, tool } }` is built across all
configured servers. It drives two things:

- **Payment routing**, and
- **Provider hiding:** any server that appears as a capability provider is
  **excluded from the toolset exposed to the model**, so the model cannot call
  `create-kya-token` / `create-pay-token` directly and bypass the gateway.

---

## 6. Connection Lifecycle & Status Model

### 6.1 Connection states

A client tracks where each server sits in the flow. The states that matter to KYA:

- **Connected** — authenticated; the server's tools are available.
- **Not connected / disabled** — never connected this session, or turned off.
- **Awaiting KYA consent** — the server advertises KYA, and a mint would carry the
  agent's identity, so the client waits for the user to approve the sign-in before
  minting.
- **Needs interactive auth** — auth is required but KYA isn't used (not advertised, or
  no issuer is configured), so the standard interactive OAuth flow is used instead.
- **Failed** — connection or KYA minting failed; carries an error.

(A server that demands a pre-registered OAuth client but offers no dynamic client
registration is a distinct failure.)

### 6.2 KYA is triggered reactively

KYA is never performed proactively. It is triggered by an **authorization challenge**
from the protected server — a `401` (or an auth-required tool result) — which arrives
either when the client first connects or on the first protected tool call. A client
that already holds a valid access token for the server skips KYA entirely.

### 6.3 Entry point, consent, and the issuer gate

KYA has **two** entry points that share the same mint machinery, differing only in
_when_ the challenge arrives:

- **Connect-time** — the handler that fires when a transport connect returns an
  **Unauthorized (401)** and the applicability guards pass (described in this section).
- **Tool-call-time** — a 401 (or an auth-required tool result) on a _later_ tool call,
  after the agent has already connected unauthenticated.

The connect-time handler drives detection, the consent gate, the issuer check, and the
mint. Connecting a KYA-protected server therefore takes two passes:

1. **First connect (no consent).** The handler runs discovery. If the server
   advertises KYA, it stops to **await KYA consent** rather than minting —
   KYA carries the agent's identity, so the user approves it explicitly before
   any token is minted.

2. **Reconnect with consent.** The client reconnects with a consent flag. This
   time the handler passes the consent check and proceeds to the **issuer gate**:
   the configured KYA issuer must itself be enabled (connected). If it isn't, the
   connect fails with a message telling the user to enable it — connecting the
   issuer is what validates its config and API key, and this keeps KYA from
   minting through an issuer the user never enabled. (This mirrors the payment
   gateway, which only mints through a connected provider.) With the issuer
   enabled, the handler runs the silent KYA flow and retries the transport on
   success.

### 6.4 Transport selection

MCP defines two HTTP transports — **Streamable HTTP** and the older **SSE**. A client
that supports both should treat a `401` on the Streamable-HTTP attempt as "this server
speaks HTTP and needs auth" and **not** fall back to SSE (which would typically 404 and
mask the real auth/KYA failure). KYA is attempted on the Streamable-HTTP path. After a
successful mint the client retries the connection; the stored access token is now sent
on the request.

### 6.5 Tool-call-time challenge

A server need not reject the _connection_. It can accept an unauthenticated connect —
`initialize`, `tools/list`, and any **open** tools all succeed with no token — and
challenge only when a **protected** tool is called. The agent handles this lazily, in
the wrapper around each tool's `execute`:

- If a tool call surfaces an auth failure **and** the server advertises KYA, the agent
  runs the same silent KYA flow and, on success, **retries that same tool call**
  with the now-stored Bearer token. The result of the retry is returned to the model.

**Recognizing an auth-required tool result.** A server that protects individual tools
(rather than the connection) cannot always use a transport `401`, because the same
HTTP response may also carry an open call. Clients evaluate signals in this precedence
order, and servers SHOULD emit the strongest one they can:

1. **Structured `_meta` signal (authoritative).** A tool error result carrying
   `_meta["auth/required"] = { resource_metadata: "<url>", scopes?: [...] }` — the
   direct analogue of the `payments/*` `_meta` signals used by the payment gateway.
   Servers SHOULD emit this; clients MUST honor it first.
2. **Transport `401`** — `UnauthorizedError`, or an error carrying `code === 401`,
   with a `WWW-Authenticate` challenge (parsed per *Discovery & advertisement gate*).
3. **Text heuristic (last resort).** A result flagged `isError` whose text contains, on
   a word boundary and case-insensitively, one of `unauthorized` / `401` / `sign-in` /
   `kya`. This exists only for servers that return a `200`+`isError` sign-in message and
   emit no structured signal; it is best-effort and prone to false positives, so a
   client MUST guard it with the once-per-challenge rule (*When KYA applies*) and the re-mint guard
   (*Re-mint guard*).

`403` / `forbidden` is an **authorization** failure (insufficient privileges), **not**
an authentication challenge: it MUST NOT trigger a mint or re-mint (re-minting cannot
add privileges and would loop). Only `401`-class signals do.

- The mint goes through the same **enabled-issuer gate** as the connect-time path:
  no usable issuer → the call is gated with a sign-in message rather than silently
  failing. The same applicability conditions apply equally; the tool-call path keys
  off KYA advertisement plus the issuer gate.
- The stored token is reused for the rest of the session, so subsequent protected
  calls don't re-challenge.

A single server can therefore mix open and protected tools, and KYA fires the moment
the agent first touches a protected one — not necessarily at connect.

### 6.6 Consent lifecycle

Because a mint stamps the agent's (and the human's) identity onto a token, the user
approves it before the first mint for a server. The consent record:

- is **keyed by `(resource origin, seller selector)`** — the same key the token is
  stored under (*Origin normalization*). A change of origin or seller invalidates prior consent.
- **persists** with the same protection as tokens (*Token Storage*), so the user isn't re-prompted
  every session; clearing the store clears consent.
- is **reused by a re-mint after a server `401`** (*Lifetime of a KYA-minted token*): a stale token that the
  resource rejects is re-minted under the existing consent, **without** re-prompting —
  the user already authorized this agent↔seller binding. Consent is required again only
  when the key changes or the store is cleared.

Whether and how the prompt is shown is implementation-defined (*Client Surfaces*); the **key,
persistence, and re-use-on-re-mint** semantics above are normative so behavior is
consistent across surfaces.

---

## 7. The Silent KYA Flow

The flow resolves to one of three outcomes, and whether KYA was **advertised** decides
how a failure is handled:

- **Minted** — discovery, mint, and exchange all succeeded; the access token is stored.
- **Not advertised** — the AS doesn't offer the KYA grant profile, so KYA is skipped
  and the caller may fall back to interactive OAuth.
- **Advertised but failed** — KYA was offered but minting/exchange failed. This is a
  hard failure: it must **not** silently degrade to interactive OAuth.

### 7.1 When KYA applies

On an authorization challenge, KYA is attempted only when **all** of these hold:

- the target is **not the KYA issuer itself** — the issuer authenticates the client by
  its own credential (e.g. an API key), so minting a KYA token just to reach the KYA
  minter would be a chicken-and-egg deadlock;
- the client isn't already configured to authenticate to the target by **other means**
  (e.g. a static credential / header), and OAuth auto-detection isn't disabled for it;
- KYA hasn't already been attempted for this challenge (mint is tried once).

A target that doesn't meet these conditions skips KYA and follows the ordinary
OAuth path.

### 7.2 Discovery & advertisement gate

Discovery is shared by both the consent gate and the mint preflight. It yields
`{ supportsKya, authServer, sellerServiceId }`. All HTTP requests use a bounded
timeout, no automatic following of cross-origin redirects, and at most one retry.

1. **Probe.** `POST <serverUrl>` with headers `Content-Type: application/json`,
   `Accept: application/json, text/event-stream`, and the negotiated
   `MCP-Protocol-Version`, carrying a minimal JSON-RPC `initialize` body and no
   `Authorization`. (The `Accept` header matters: a Streamable-HTTP server may answer
   `406` instead of the `401` you key on if it's omitted.) If the response is `401`,
   parse `WWW-Authenticate` per RFC 9110: select the `Bearer` challenge, read its
   comma-separated auth-params (`resource_metadata`, `error`, `error_description`,
   `scope`), and resolve a relative `resource_metadata` against the request origin.
   If there's no 401 or no pointer, fall back to `<origin>/.well-known/oauth-protected-resource`.

   > **SSRF guard.** Before fetching a `resource_metadata` URL taken from a response,
   > require it to be **same-origin with the resource** (or on an explicit allow-list).
   > Never follow an arbitrary attacker-suppliable metadata URL — it can redirect the
   > agent's identity assertion to a hostile token endpoint (*Security Considerations*, the standards & hardening section).

2. **Protected-resource metadata.** `GET` the resource-metadata URL with
   `Accept: application/json`. Read:
   - `authorization_servers: string[]` → the Resource AS issuer (`[0]`; if multiple are
     listed only the first is used).
   - optionally `seller_service_id` → a seller identity the resource advertises for
     itself.

3. **AS metadata.** `GET <authServer>/.well-known/oauth-authorization-server`
   (RFC 8414, `Accept: application/json`), falling back to
   `/.well-known/openid-configuration`. **Validate the issuer** (RFC 8414 §3.3): the
   metadata `issuer` MUST match the URL it was fetched from. Read
   `authorization_grant_profiles_supported` and check whether it advertises the KYA
   profile (normalizing both the full URN `urn:ietf:params:oauth:grant-profile:kya`
   and the short token `kya`).

**The advertisement gate:** if the profiles do not include `kya`, KYA is treated as
**not advertised** — it is skipped and the caller may fall back to interactive OAuth.
Once past this gate, any _subsequent_ failure is treated as **advertised but failed**
(a hard failure).

**Classifying discovery defects** (this decides fallback-eligible vs. hard-fail):

| Condition | Classification |
| --- | --- |
| No 401 / no metadata / network or parse error / non-OK metadata fetch | **Not advertised** → fallback eligible |
| `authorization_servers` missing, empty, non-array, or `[0]` not a valid origin | **Not advertised** → fallback eligible |
| AS metadata fetched OK but `authorization_grant_profiles_supported` omits `kya` | **Not advertised** → fallback eligible |
| KYA advertised, but AS metadata later missing `token_endpoint` (detected at the exchange) | **Advertised but failed** → hard fail |

> All of discovery is wrapped so a discovery/network failure degrades to "KYA not
> advertised," not a hard error.

### 7.3 Seller selector resolution

The issuer tool requires **exactly one** seller selector. Priority:

1. **Explicit override** (a configured `sellerServiceId` UUID) → `{ sellerServiceId }`.
2. **`seller_service_id`** advertised by the protected-resource metadata → `{ sellerServiceId }`.
3. **Derived from the target MCP URL** → `{ sellerDomainOrUrl }`: the target's
   hostname. A hostname the issuer's seller directory can't resolve (e.g. a
   non-publicly-routable address) is substituted with a configured placeholder domain
   that the directory does recognize.

### 7.4 Mint the KYA assertion

1. If no issuer is configured, KYA cannot be minted (there is nothing to attempt), so
   the agent falls back to interactive OAuth — the same outcome as when KYA isn't
   advertised. This is **not** treated as a hard failure.
2. Connect to the issuer over its configured transport, carrying the issuer's
   credential (e.g. an API-key header).
3. Invoke the issuer's configured KYA tool (an MCP `tools/call`) with the resolved
   seller selector as its **sole** argument — the KYA mint tool takes no other
   parameters (*Seller selector resolution*) — then close the issuer connection.
4. Extract the assertion from the result, preferring a **structured** field over prose:
   - **Structured (preferred).** If the result exposes `structuredContent` or a
     `_meta` field carrying the assertion (e.g. `_meta["org.kyapay/kya"].assertion`),
     use it directly. Issuers SHOULD provide this.
   - **Text fallback.** Otherwise scan the concatenated text content with a regex
     **anchored on the JOSE header prefix** `eyJ`:
     `/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/`. Anchoring on `eyJ`
     (base64url of `{"`) avoids matching unrelated dotted tokens (version strings,
     hostnames, file paths). If several match, select the **first whose decoded header
     `typ` is a KYA token type** (e.g. `kya+jwt`). (The issuer tool may wrap the token
     in a human-readable string such as `"Creation of KYA token for <id> is complete:
     <jwt>"`.)
   - A result flagged `isError`, or one yielding no decodable assertion, is an error
     result.

The result is a signed **KYA assertion** (a JWT) — *not* an access token. It is a
short-lived, issuer-signed attestation of the agent's identity and the seller it
intends to act against. Its claims are exactly what the Resource AS validates during
the exchange:

| Claim          | Where   | Meaning                                                                          |
| -------------- | ------- | -------------------------------------------------------------------------------- |
| `alg`          | header  | Signature algorithm — **`ES256`** in the reference deployment.                  |
| `typ`          | header  | Token type, e.g. **`kya+jwt`**.                                                  |
| `iss`          | payload | Issuer — the issuer's environment origin (a distinct origin per environment).   |
| `env`          | payload | Environment label: `production` / `sandbox` / `qa`.                              |
| `sub`          | payload | Subject — the agent identifier (UUID).                                           |
| `aud`          | payload | Audience — the seller's id (a UUID, **not** a URL).                              |
| `sdm`          | payload | **Seller domain** (e.g. `store.example.com`) — present for *external-seller* tokens. |
| `ssi`          | payload | **Seller service id** (UUID) — present for *onboarded-service* tokens (instead of `sdm`). |
| `jti`          | payload | Unique token id (UUID) — used for replay protection.                             |
| `iat` / `exp`  | payload | Issued-at / expiry, epoch seconds. KYA assertions are short-lived (~minutes).    |
| `hid`          | payload | **Human identity**: `{ email, verifier, verified }`.                             |
| `aid`          | payload | **Agent identity**: `{ name, … }`.                                               |
| `apd`          | payload | Agent platform / organization data.                                              |
| `ori`          | payload | Origin.                                                                          |
| `scope`        | payload | Requested scope (often empty).                                                   |

Payment (`kya-pay` / `pay`) tokens additionally carry settlement claims — `stp`
(settlement type: coin/card/bank), `sps` (price model), `spr` (price). Those belong
to the payment flow, not the auth exchange.

### 7.5 Exchange the assertion for an access token (RFC 7523)

1. **Read the AS `token_endpoint`** from the AS metadata. Missing → error result.
2. `POST <token_endpoint>` with `content-type: application/x-www-form-urlencoded`
   and body:

   ```
   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
   assertion=<KYA JWT>
   resource=<canonical resource URI>     # RFC 8707; see "Audience binding" below
   ```

   This is the **RFC 7523 JWT-bearer grant**. A non-2xx response is a hard failure
   (`invalid_grant`, …; the full error catalog is in *What the Resource AS validates*).

   > **The exchange is client-unauthenticated.** The request carries no
   > `client_id`/`client_secret`, no `Authorization` header, and **no `scope`**. All
   > trust derives from the issuer-signed assertion, which the AS validates (*What the Resource AS validates*). With
   > no scope requested, the AS assigns its **configured default scope for that
   > resource** (the reference deployment uses `mcp`); the assertion's own `scope` claim
   > (usually empty) is not honored.

   **Audience binding (how the AS knows which resource the token is for).** The issued
   `aud` is the load-bearing security control (*What the MCP server validates*), so the AS must know the target
   resource. The client SHOULD send the RFC 8707 `resource` parameter set to the
   resource's **canonical URI** (the `resource` value from its protected-resource
   metadata — *Server-Side Requirements*). An AS that fronts a single resource MAY infer it; a multi-resource
   AS MUST require `resource` and reject an unknown one (`invalid_target`). The
   assertion's `aud` is the **seller** id, not the resource, so it cannot serve this
   purpose.

   **Single-use assertion.** Each assertion carries a unique `jti` and is consumed by
   the AS's replay cache (*What the Resource AS validates*) on first acceptance. A client MUST therefore **mint a
   fresh assertion for every exchange attempt** — never resend the same assertion. If a
   `POST /token` times out with an unknown outcome, the client MUST re-mint (new `jti`)
   rather than retry the original, or it will hit `invalid_grant` (replay) on a request
   that may actually have succeeded.

3. On success the AS returns a standard OAuth token response:

   ```json
   { "access_token": "<jwt>", "token_type": "Bearer", "expires_in": 3600, "scope": "…" }
   ```

   The **access token** is an ordinary OAuth 2.1 bearer credential minted *for this
   resource*: its `aud` is the resource's canonical URI and it carries the resource's
   scope (e.g. `mcp`). The agent presents it as `Authorization: Bearer <access_token>`
   and the MCP server validates it as a plain resource server, with **no KYA
   awareness**. The agent persists **only** `access_token` (keyed by the resource's
   URL origin so the credential layer finds it); `expires_in`, `scope`, and any
   `refresh_token` are dropped (*Lifetime of a KYA-minted token* explains the trade-off; the standards & hardening section notes the
   honor-`expires_in` hardening option).

### 7.6 What the Resource AS validates — the KYA assertion

The integration involves **two** tokens, validated by **two** parties at **two**
different points:

| Token             | Validated by            | When                                |
| ----------------- | ----------------------- | ----------------------------------- |
| **KYA assertion** | the Resource AS         | at the jwt-bearer `/token` exchange |
| **Access token**  | the MCP resource server | on every authenticated request      |

This section covers the **KYA assertion**; the next subsection covers the **access
token**.

The exchange's security rests entirely on the AS validating the assertion before it
mints anything. The reference algorithm follows the issuer's published KYA
token-verification example; the steps below match it.

1. **Signature + algorithm + issuer.** Verify the JWS against the issuer's **JWKS**,
   selecting the key by the header `kid`. Require `iss` to equal the expected issuer
   for the target environment, and validate `alg` against a configured **allow-list of
   asymmetric algorithms** (the reference deployment uses `ES256`). The verification
   algorithm MUST be taken from server config, never inferred from the token header;
   `alg: none` and **all symmetric (`HS*`) algorithms MUST be rejected** to prevent
   algorithm-confusion attacks (RFC 8725 §3.1–§3.2). The JWKS URI and the expected
   `iss` are established out-of-band, not derived from the assertion — see *Issuer trust & key handling*. (The
   JWT library also enforces `exp`/`nbf` here, within the skew tolerance of *Replay protection & clock skew*.)
2. **Header `typ`** equals the expected KYA token type (e.g. `kya+jwt`).
3. **Common payload claims:**
   - `env` equals the expected environment (`production` / `sandbox` / `qa`);
   - `iat` is a 10-digit epoch-seconds value **in the past**;
   - `jti` is a valid **UUID**;
   - `exp` is a 10-digit epoch-seconds value **in the future**.
4. **Seller binding** — exactly one of:
   - **external seller:** `sdm` equals the seller's own domain (`EXPECTED_SDM`); or
   - **onboarded service:** `ssi` equals the seller's service id (`EXPECTED_SSI`).
5. **KYA identity:** `hid.email` is a valid email address. Stricter deployments also
   assert `hid.verified === true` and the presence of the agent (`aid`) and org (`apd`).

Two checks layered on top of the stateless example:

- **Replay protection.** The AS remembers each accepted `jti` until its `exp` and
  rejects a second presentation of the same `jti` (`invalid_grant`), making a captured
  assertion single-use within its short lifetime.
- **Required identity claims.** `aid` and `hid` must be present before a token is
  minted — the principal stamped onto the issued access token is derived from them
  (e.g. `sub` ← `hid.email`).

Each "expected" value is **deployment configuration the seller sets**: environment,
issuer (derived from environment), algorithm, `typ`, and the seller identity (`sdm`
**or** `ssi`). `aud` is validated only when the deployment pins an expected audience;
the external-seller profile typically leaves it open, because the assertion's `aud`
is the seller's UUID rather than the AS.

| Field        | Source        | Rule                                                       |
| ------------ | ------------- | ---------------------------------------------------------- |
| signature    | header + JWKS | verifies against the issuer's JWKS                         |
| `alg`        | header        | `=== ES256`                                                |
| `typ`        | header        | `=== EXPECTED_TYP` (e.g. `kya+jwt`)                        |
| `iss`        | payload       | `===` issuer for `EXPECTED_ENV`                            |
| `env`        | payload       | `=== EXPECTED_ENV`                                          |
| `iat`        | payload       | epoch seconds, `<= now`                                    |
| `exp`        | payload       | epoch seconds, `>= now` (also enforced by the JWT library) |
| `jti`        | payload       | valid UUID **and** not previously seen (replay)            |
| `sdm`        | payload       | `=== EXPECTED_SDM` (external seller)                       |
| `ssi`        | payload       | `=== EXPECTED_SSI` (onboarded service)                    |
| `hid.email`  | payload       | valid email; `aid` + `hid` present                         |
| `aud`        | payload       | checked only if an expected audience is configured         |

A failed check mints **no** access token and returns a token-endpoint error per the
catalog in *Token-endpoint error responses*. (A signature/JWKS or `iss` mismatch most often means the assertion
was minted for a **different environment** than the AS expects.)

#### 7.6.1 Issuer trust & key handling

The AS's trust in the issuer is anchored **out-of-band**, not by the assertion:

- **Per-tenant issuer allow-list.** Each trusted issuer is pre-registered with: its
  exact `iss` value(s) per environment, a **pinned `jwks_uri`**, the permitted `alg`
  set, the permitted `env`, and which seller bindings (`sdm`/`ssi`) it may assert. The
  AS resolves keys from the *registered* `jwks_uri` only — it MUST NOT fetch a JWKS URL
  derived from the (still-unverified) assertion's `iss`, which would let an attacker
  choose the key that verifies their own token and is an SSRF vector.
- **Expected `iss` per environment.** A normative mapping `EXPECTED_ENV → iss` is part
  of issuer registration, e.g. `production → https://issuer.example`,
  `sandbox → https://sandbox.issuer.example`, `qa → https://qa.issuer.example`. (Pin
  the exact origins for your deployment.)
- **JWKS caching & rotation.** Cache by `iss`, honoring HTTP `Cache-Control`/`max-age`
  within a bounded min/max TTL. Select the key by `kid`; on an unknown `kid`, refetch
  once (rate-limited) before failing. Fetch with a strict timeout, a response-size cap,
  and an egress allow-list; negative-cache failures to avoid retry storms. A JWKS that
  is unreachable yields a `temporarily_unavailable` / `503`, not a validation error.

#### 7.6.2 Replay protection & clock skew

- **Replay store.** The AS records each accepted `(iss, jti)` with an **atomic
  insert-if-absent** (e.g. a conditional write / `SETNX`); a present key is a replay →
  `invalid_grant`. The store MUST be **shared and linearizable across all AS
  instances** (or the AS declared single-instance) — a per-process in-memory set does
  not prevent replay behind a load balancer. Retention TTL = `exp + clock_skew`.
- **Clock skew.** Apply a small, fixed tolerance (e.g. ±60 s) consistently to `iat`
  (`<= now + skew`), `exp` (`>= now − skew`), and `nbf`. Because assertions are
  short-lived (~minutes), keep the skew small.
- **Check-then-record ordering.** Record the `jti` only after all other checks pass,
  using the atomic operation above so two concurrent presentations can't both succeed.

#### 7.6.3 Token-endpoint error responses

All errors use HTTP **`400`** with `Content-Type: application/json`,
`Cache-Control: no-store`, and body `{ "error": "...", "error_description": "..." }`
(RFC 6749 §5.2). The grant is client-unauthenticated, so `invalid_client` / `401` does
**not** apply. `error_description` SHOULD NOT reveal which specific check failed (avoid
a validation oracle).

| Failure | `error` |
| --- | --- |
| Missing/duplicate `grant_type`/`assertion`, wrong content-type, malformed JWT | `invalid_request` |
| Unsupported `grant_type` value | `unsupported_grant_type` |
| Signature/`alg`/`iss`/`typ`/`env` mismatch, `exp`/`iat`/`nbf` out of range, bad `jti`, seller-binding (`sdm`/`ssi`) mismatch, missing `hid`/`aid`, invalid email, **replay** | `invalid_grant` |
| Unknown/disallowed `resource` (RFC 8707) | `invalid_target` |
| Issuer JWKS unreachable (AS-internal) | `temporarily_unavailable` (HTTP `503`) |

#### 7.6.4 Access-token construction

On success the AS mints the access token the resource will validate (*What the MCP server validates*):

- **Format.** A signed JWT (RFC 9068), header `typ: at+jwt`, signed with the AS's own
  signing key (published at the AS's `jwks_uri` — *Server-Side Requirements*), using an asymmetric `alg`.
- **Claims.** `iss` = the AS issuer identifier; `aud` = the **canonical resource URI**
  determined per the exchange; `sub` = the principal derived from the assertion (reference:
  `sub ← hid.email`; see the standards & hardening section for the delegation-vs-impersonation hardening that
  recommends a stable pseudonymous `sub` plus an `act` actor claim); `scope` = the
  resource's default/granted scope; `exp`, `iat`, and SHOULD `nbf`, `jti`.
- **Lifetime.** Configurable; the reference deployment issues `expires_in: 3600`.
- The issued token carries **no KYA-specific claims** — the resource validates it as an
  ordinary OAuth 2.1 access token.

### 7.7 What the MCP server validates — the access token

The access token returned by the exchange is an **ordinary OAuth 2.1 bearer
credential**, and the MCP resource server validates it exactly as any OAuth 2.1
resource server would — with **no KYA awareness**. The KYA assertion is *not* seen at
this point; it was already consumed by the AS at the exchange (previous subsection).
The resource server only sees `Authorization: Bearer <access_token>` and checks the
access token's own properties:

| Property      | Source        | Rule                                                                         |
| ------------- | ------------- | ---------------------------------------------------------------------------- |
| signature     | JWS + AS keys | verifies against the Resource AS's signing keys (its JWKS)                    |
| `iss`         | payload       | `===` the expected Resource AS                                               |
| `aud`         | payload       | `===` the resource's **own canonical URI** (audience binding)                |
| `exp`         | payload       | not expired (`>= now`)                                                       |
| `nbf` / `iat` | payload       | token is currently valid (not used before its time)                          |
| `scope`       | payload       | includes the scope the requested operation requires (e.g. `mcp`)            |

Key points:

- **Audience binding** is the load-bearing check: because the AS sets `aud` to this
  resource's URI, a token minted for resource X cannot be replayed against resource Y.
  The match is **exact** against the resource's canonical URI (the `resource` value in
  its protected-resource metadata — *Server-Side Requirements*), after normalizing scheme/host to lowercase,
  eliding the default port, and dropping any trailing slash/fragment. The AS and the
  resource MUST agree on this string byte-for-byte (note `https://host` vs
  `https://host/mcp` — pick one and publish it). If `aud` is an array, membership
  satisfies the check.
- **Key source.** The resource validates the signature against the **AS's** JWKS,
  fetched from the AS metadata `jwks_uri` (*Server-Side Requirements*) — distinct from the issuer JWKS used in
  *What the Resource AS validates*. Apply the same `kid` selection, caching, and rotation discipline as *Issuer trust & key handling*, and
  the same clock-skew tolerance as *Replay protection & clock skew*.
- **Transmission.** Accept the token only via the `Authorization: Bearer` header
  (scheme case-insensitive); reject query- or body-parameter tokens (advertise
  `bearer_methods_supported: ["header"]`).
- The resource server is a **plain OAuth 2.1 resource server** — it neither parses nor
  trusts anything KYA-specific. All KYA-specific validation (signature against the
  *issuer's* JWKS, `typ`, `env`, seller binding, replay) happened earlier at the AS.
  The two validation steps use **different keys** and **different audiences**.

**Status codes (RFC 6750) — this controls the client's re-mint loop:**

| Condition | Status | `WWW-Authenticate` |
| --- | --- | --- |
| No `Authorization` header | `401` | bare `Bearer` challenge + `resource_metadata` |
| Malformed / bad signature / wrong `iss` or `aud` / expired | `401` | `Bearer error="invalid_token"` + `resource_metadata` |
| Valid token, missing required scope | `403` | `Bearer error="insufficient_scope", scope="…"` |

Only a `401` (an **authentication** challenge) re-enters the silent KYA flow and
triggers a fresh mint (*Lifetime of a KYA-minted token*). A `403 insufficient_scope` is an **authorization**
failure — re-minting cannot add scope, so the client MUST NOT re-mint on `403` (doing
so loops). The resource does **not** track access-token `jti` for replay; bearer tokens
are replayable until `exp` by design.

### 7.8 Failure semantics

- If discovery passed the advertisement gate, any later failure — issuer connect, mint
  tool call, or token exchange — is an **advertised-but-failed** result. This is
  deliberate: a genuine KYA failure must **not** silently degrade to interactive OAuth.
- If KYA was never advertised, the result is simply **not advertised**, and the caller
  may fall back to interactive OAuth.

### 7.9 Lifetime of a KYA-minted token (no local expiry, no refresh)

Because the client stores no expiry timestamp and no refresh token for a KYA-minted
token:

- The token reads as **authenticated indefinitely** in status checks — even after
  the AS-issued `expires_in` has actually elapsed.
- The agent therefore does **not** proactively re-mint on a timer. A stale token is
  replaced only when the **MCP server rejects it with a 401**, which re-enters the
  connect flow and runs the silent KYA flow again (a fresh mint).
- There is no refresh-token path for KYA tokens; "refresh" is always a full re-mint
  via the issuer.

### 7.10 Re-mint guard (preventing a mint→401 loop)

The "re-mint on 401" model (*Lifetime of a KYA-minted token*) can loop if the AS keeps minting a token the resource
keeps rejecting — e.g. an `aud` the resource doesn't recognize, an `iss`/scope/clock
mismatch, or an environment misconfiguration. The mint *succeeds* but the next request
still `401`s, which would trigger another mint, forever.

Clients MUST bound this:

- A mint is attempted **once per challenge** (*When KYA applies*). If a freshly minted-and-stored
  token is **immediately rejected** by the resource on the very next authenticated
  request, treat it as **advertised-but-failed** (a hard error surfaced to the user) —
  do **not** re-mint again for the same challenge.
- Bound re-mints per `(origin, time window)` with a minimum backoff, so transient
  causes recover but a persistent misconfiguration fails fast with a clear error rather
  than hammering the issuer and AS (and burning `jti`s).

---

## 8. Client Responsibilities

Whatever OAuth machinery a client uses for the transport (auto-connect and the
interactive flow), it must handle the following.

### 8.1 Origin normalization

Discovery metadata (`/.well-known/*`) lives at the server's **origin**, but MCP
transport URLs often include a `/mcp` path. The client must normalize to the origin
so that (a) discovery doesn't 404 on `/mcp/.well-known/*`, and (b) a token stored by
KYA (keyed by origin) is found again on lookup. The canonical origin is
**lowercased scheme + host, default port elided, path/query/fragment dropped**
(`https://Merchant.example.com:443/mcp` → `https://merchant.example.com`); this exact
string is the token-store key. `http` and `https` on the same host are distinct keys.

### 8.2 Token & client storage

- **Token read** returns a stored token **only if its origin matches** — preventing
  reuse across a changed URL.
- **Token save** persists access/refresh/expiry/scope (KYA stores only the access
  token).
- **Client information** prefers a configured `client_id`, else a stored
  dynamically-registered client (re-registering if its secret expired).
- **PKCE / CSRF state** (the code verifier and `state`) is persisted for the
  interactive flow.

### 8.3 Discovery via `WWW-Authenticate`

A client may proactively probe the origin to provoke a `401` and read the advertised
metadata from the `WWW-Authenticate` header, rather than guessing the well-known
location — useful when an MCP origin returns a plain-text 404 for `/.well-known/*`.

### 8.4 KYA runs out of band, not through grant-profile hooks

KYA is **not** driven through the OAuth library's grant-profile hooks. It runs out of
band: the client discovers, mints, exchanges, and stores the access token **before**
retrying the transport, so the transport simply finds a valid token. This keeps the
KYA path authoritative and lets the library fall back to interactive
`authorization_code` when KYA is unavailable.

### 8.5 Concurrency

A stored token record SHOULD carry a discriminator (e.g. the grant/issuer that produced
it) so the credential layer knows whether to **re-mint on 401** (KYA, no proactive
refresh — *Lifetime of a KYA-minted token*) or **proactively refresh** (interactive, which has a refresh token).

Minting MUST be **single-flight per `(origin, seller)`**: when several challenges race
(two protected tool calls 401 at once, or a connect racing a first tool call), only one
mint runs; the others await its result and reuse the stored token. Without this, N
concurrent challenges produce N assertions/`jti`s and N exchanges, several landing after
another already stored a token, with last-writer-wins clobbering. A token stored by
either entry point (connect-time or tool-call-time) MUST be visible to the other before
its retry. If the issuer connection is per-mint (*Mint the KYA assertion*), the single-flight guard also
serializes its open/close so concurrent mints don't race the close.

---

## 9. Decision Matrix (Gating Logic)

For an auth-required server where KYA applies, the outcome resolves in this order.
"Usable issuer" means an issuer is configured **and** enabled.

| KYA advertised? | Consent given? | Issuer                          | Outcome                               |
| --------------- | -------------- | ------------------------------- | ------------------------------------- |
| No              | —              | —                               | **Interactive OAuth**                 |
| Yes             | no             | —                               | **Await KYA consent** (user approval) |
| Yes             | yes            | configured + enabled → mint ok  | **Connected** via Bearer              |
| Yes             | yes            | configured + enabled → mint fails | **Fail** (clear KYA error)          |
| Yes             | yes            | configured but not enabled      | **Fail** (enable the issuer)          |
| Yes             | yes            | none configured                 | **Interactive OAuth**                 |

Interactive OAuth is always available as the fallback: whenever KYA isn't used — the AS
doesn't advertise it, or no issuer is configured to mint with — the agent runs the
standard interactive flow. Two cases are deliberately surfaced rather than silently
downgraded to a browser prompt, because each signals a real problem to fix: a
configured-but-disabled issuer (enable it) and a genuine mint failure (a broken KYA
setup that shouldn't be masked). Requiring consent and an enabled issuer keeps minting
deliberate and tied to a validated issuer.

---

## 10. Interactive OAuth Fallback

When the decision matrix lands on interactive OAuth, the client runs the standard
**Authorization Code + PKCE** flow (RFC 7636) against the same Resource AS:

1. Discover the AS and obtain a client registration if the AS requires one — a
   configured `client_id`, or one from dynamic client registration (RFC 7591).
2. Generate a PKCE verifier/challenge and a random `state`, then open the AS's
   authorization endpoint in a browser.
3. The user authenticates and consents; the AS redirects back to the client's
   **redirect URI** with `code` and `state`.
4. The client **validates `state`** against the value it generated (CSRF defense), then
   exchanges `code` at the token endpoint with the PKCE verifier for an access token.
5. The client stores the token and connects.

The redirect URI is an address the client listens on for the callback, per the OAuth
native-app guidance. `state` is mandatory — a missing or unknown `state` on the
callback is rejected as a possible CSRF attack — and a pending request times out if no
callback arrives.

> **Co-location limitation:** the redirect lands on the **client's** host, so the
> interactive flow only completes when the browser and the client can reach the same
> redirect address. The KYA flow has no such limitation — it involves no browser.

---

## 11. Token Storage

A client persists the access token — and, for the interactive flow, the client
registration and PKCE/CSRF state — so it can reuse them across requests and sessions.
Requirements:

- **Bind tokens to the server origin.** A stored token is returned only for the origin
  it was issued for, so it can't be presented to a different server.
- **Protect the store.** These are bearer credentials — persist them in a private
  location with owner-only permissions, never alongside shared or version-controlled
  files.
- **KYA stores only the access token.** The refresh token, scope, and expiry from the
  exchange response are not retained for KYA-minted tokens, which is why such a token
  has no locally tracked expiry and is re-minted only when the server returns a `401`.

Clearing the store forces a clean re-auth on the next connection.

---

## 12. Payment Capability (`org.kyapay:pay`) — Sibling Feature

The same capability machinery is reused at **tool-call time** to mint _payment_
tokens. When any capability is configured, each tool call routes through a gateway
wrapper:

1. Call the requested tool normally.
2. If the result is an error carrying a `payments/*` signal in `_meta` — settlement
   types, total, currency, optional seller id/search — the gateway intercepts.
3. Match a settlement type to a provider via longest-prefix match against the
   capability map.
4. Resolve the seller id (from the signal, or via the issuer's seller-lookup tool).
5. Call the issuer's pay tool (e.g. `create-pay-token`), forwarding amount/currency
   in `_meta`. If the issuer returns a **mandate** signal, open the mandate URL in a
   browser and ask the user to retry.
6. Cache the minted token (keyed by settlement type/total/currency, with a small
   pre-expiry guard).
7. Retry the original tool with `payments/settlement/token` injected in `_meta`.

The gateway shares the issuer-hiding rule: provider servers are excluded from the
model-visible toolset so the model can't call the mint tools directly.

> **KYA vs. pay:** KYA mints an _auth_ assertion to _connect_ to a server; pay mints
> a _payment_ token to _settle a transaction_ with an already-connected server. Both
> go through the same configured issuer; only the capability URI and tool differ.

---

## 13. Configuration Options

A configurable behavior, evaluated at access time:

| Option                         | Effect                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| **Seller-service-id override** | Pins the seller selector to a specific `sellerServiceId` UUID, overriding URL-derived selection. |

---

## 14. Client Surfaces

However a client exposes connect/auth — a UI toggle, an HTTP API, a CLI — it runs the
same detection and consent gate. The surface only needs to:

- start a connection to a server;
- when the server is **awaiting KYA consent**, obtain the user's approval before any
  token is minted, then proceed with the mint (how consent is requested — the prompt
  wording, and whether it's shown at all — is implementation-defined);
- when the server **needs interactive auth**, drive the standard interactive OAuth flow
  (which opens a browser; note the co-location caveat);
- surface connection state and errors back to the user.

The mint, exchange, and validation are identical regardless of surface — only how the
user is prompted and where any browser step lands differ.

---

## 15. Server-Side Requirements

For the exchange to work, the protected MCP server and its Authorization Server must
implement the following (the server-side counterparts to the client flow).

### 15.1 Protected MCP resource

**Protected-resource metadata** — `GET /.well-known/oauth-protected-resource` (RFC
9728), served `Content-Type: application/json`, **no auth required**:

| Field | Req? | Value |
| --- | --- | --- |
| `resource` | required | the resource's **canonical URI** — the exact string the AS stamps as `aud` and the resource validates (*What the MCP server validates*). Publish either the origin or the `/mcp` endpoint and use it consistently everywhere. |
| `authorization_servers` | required | array of AS issuer URLs; clients use `[0]`. |
| `scopes_supported` | recommended | e.g. `["mcp"]` — the scopes the resource recognizes. |
| `bearer_methods_supported` | recommended | `["header"]` (tokens accepted only in the `Authorization` header). |
| `seller_service_id` | optional | the seller's service id (UUID), for onboarded-service deployments; corresponds to the assertion `ssi`. Omit for external-seller-by-domain deployments. (Vendor extension, not an RFC 9728 field.) |

**MCP endpoint** — `POST /mcp` (`initialize`, `tools/list`, `tools/call`):

- A request lacking a valid Bearer token is challenged with a `401` and a
  `WWW-Authenticate` header (RFC 9728 / RFC 6750). Canonical form:
  `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="https://<resource>/.well-known/oauth-protected-resource"`.
  Use `resource_metadata` (the RFC 9728 pointer); omit `error` for a *missing* token,
  include `error="invalid_token"` for an invalid/expired one. (`realm` and
  `authorization-uri` are not required and not standardized — don't rely on them.)
- **Two protection models** (both conformant — pick one):
  *connect-time* — `401` the whole endpoint, including `initialize`; or
  *open/protected-tool* — leave `initialize`/`tools/list` and listed open tools
  unauthenticated and challenge only on a protected `tools/call`, preferably via the
  structured `_meta` auth signal (*Tool-call-time challenge*) rather than a substring-detectable message.
- **Per-tool scope.** Publish a tool→required-scope mapping and enforce it in the
  `tools/call` handler before dispatch (e.g. open tools = none; protected tools =
  `mcp`, or finer-grained `mcp:read`/`mcp:write`). Insufficient scope → `403`
  `insufficient_scope` (*What the MCP server validates*), never `401`.
- **Token validation** — as a plain OAuth 2.1 resource server (*What the MCP server validates*): signature against
  the AS `jwks_uri`, `iss`, exact `aud`, `exp`/`nbf` with skew, required `scope` — with
  **no KYA awareness**.
- **CORS** (browser-adjacent clients): allow the `.well-known/*` and `/mcp` origins,
  handle `OPTIONS` preflight, and `Access-Control-Expose-Headers: WWW-Authenticate` so
  the challenge is visible to JS clients.

### 15.2 Resource Authorization Server

**AS metadata** — `GET /.well-known/oauth-authorization-server` (RFC 8414, with
`/.well-known/openid-configuration` as a fallback):

| Field | Req? | Value |
| --- | --- | --- |
| `issuer` | required | the AS issuer identifier; MUST match the metadata URL (RFC 8414 §3.3). |
| `token_endpoint` | required | the `/token` endpoint. |
| `jwks_uri` | required | the AS's signing keys — the resource fetches these to validate access tokens (*What the MCP server validates*). |
| `grant_types_supported` | required | includes `urn:ietf:params:oauth:grant-type:jwt-bearer`. |
| `scopes_supported` | recommended | the scopes the AS may issue. |
| `authorization_grant_profiles_supported` | required for KYA | includes `urn:ietf:params:oauth:grant-profile:kya`. Omitting it is what makes a client fall back to interactive OAuth. (Vendor/experimental field — see the standards-status note and the standards & hardening section.) |

- `POST /token` — the jwt-bearer exchange: validate the assertion (*What the Resource AS validates*), enforce
  replay/skew (*Replay protection & clock skew*), and mint the access token (*Access-token construction*) with `aud` = the resource
  determined per the exchange. Errors per the catalog in *Token-endpoint error responses*.
- **Multi-tenancy.** If one AS fronts multiple sellers/resources, define how a tenant is
  resolved for a request that carries only `grant_type`+`assertion`(+`resource`): prefer
  the RFC 8707 `resource` parameter (and/or a per-seller token endpoint) to select the
  tenant's expected values *before* validating, rather than trusting the unverified
  assertion to choose its own validation rules.
- For the interactive fallback: `GET /authorize` (Authorization Code + PKCE),
  dynamic client registration, and the `authorization_code` grant at the token endpoint.

---

## 16. End-to-End Sequence

Actors: **A** = Agent, **M** = MCP server (resource), **AS** = Resource AS (OAuth),
**I** = KYA Issuer.

**Case 0 — the target IS the issuer** (advertises `org.kyapay:kya`): A connects with
its configured API-key header; the KYA branch is skipped (the issuer authenticates
itself).

**Case 1 — KYA path** (normal remote server, KYA advertised, consent given, issuer
enabled):

```
1.  A  → M    POST /mcp (no Authorization)
2.  M  → A    401 WWW-Authenticate, resource_metadata=…
3.  A  → M    GET /.well-known/oauth-protected-resource
4.  M  → A    { authorization_servers:[AS], seller_service_id? }
5.  A  → AS   GET /.well-known/oauth-authorization-server
6.  AS → A    { token_endpoint, authorization_grant_profiles_supported }   (KYA advertised)
    ── first pass stops at needs_kya_consent; user approves → reconnect with consent ──
7.  A  → I    connect + tools/call <kya tool> (seller selector)
8.  I  → A    KYA JWT assertion
9.  A  → AS   POST /token  grant_type=jwt-bearer & assertion=<JWT>
10. AS → I    fetch JWKS, verify assertion signature
11. AS → A    { access_token (aud = MCP) }
12. A  → M    POST /mcp + Authorization: Bearer <access_token>
13. M  → A    200 OK + tools — connected
```

If no issuer is configured, step 7 never happens and A falls through to Case 2
(interactive OAuth). If an issuer **is** configured but not enabled, the result is
`failed` ("enable the issuer") so the user can connect it and retry.

**Case 2 — interactive fallback** (KYA not advertised, or no issuer configured):

```
A  → AS   GET /authorize?response_type=code&code_challenge=…   (browser)
AS → A    302 → redirect_uri?code=…                            (client callback)
A  → AS   POST /token  grant_type=authorization_code & code_verifier
AS → A    { access_token }
A  → M    POST /mcp + Authorization: Bearer <access_token>
M  → A    200 OK + tools — connected
```

The steps above show the challenge arriving at connect. The **tool-call-time** variant
is the same mint/exchange, just triggered later: the connect succeeds with no token,
the agent calls open tools normally, and the `401` (or `isError` sign-in result)
arrives on the first **protected `tools/call`** — at which point the mint runs and the
agent retries that tool call with the Bearer token.

---

## 17. Error Handling & Edge Cases

| Situation                            | Behavior                                            |
| ------------------------------------ | --------------------------------------------------- |
| Invalid server URL                   | Fail immediately                                    |
| Discovery/network error              | Treated as "KYA not advertised" → fallback eligible |
| KYA advertised, not yet consented    | Await KYA consent (user approval)                   |
| Issuer configured but not enabled    | Fail ("enable it, then retry")                      |
| KYA advertised, no issuer configured | Fall back to interactive OAuth                      |
| Issuer returns non-JWT text          | Fail ("could not extract JWT assertion…")           |
| AS metadata missing `token_endpoint` | Fail                                                |
| Token exchange non-2xx               | Fail with status + body (see *Token-endpoint error responses*)      |
| `/token` timeout, outcome unknown    | Re-mint a fresh assertion (new `jti`); never resend |
| Replay (`invalid_grant` on reused `jti`) | Re-mint a fresh assertion (bounded by *Re-mint guard*)    |
| Freshly minted token still `401`s    | Hard fail (advertised-but-failed); no re-mint loop (*Re-mint guard*) |
| Valid token, insufficient scope (`403`) | Authorization failure — surface it; do **not** re-mint |
| 401 on Streamable HTTP               | Don't fall back to SSE; take the auth path          |
| Server needs pre-registered client   | Needs client registration (no DCR available)        |
| Interactive: missing/invalid state   | Callback rejected (CSRF)                            |
| Interactive: state mismatch          | Rejected ("OAuth state mismatch")                   |
| Browser won't open                   | Surface the authorization URL for manual opening    |
| Callback timeout                     | Reject after a timeout                              |
| Token bound to wrong origin          | Token lookup returns nothing → re-auth              |

---

## 18. Security Considerations

- **No secrets in plaintext config.** The issuer's API key is supplied via environment
  interpolation; tokens are stored mode-restricted in a private location, never
  alongside shared or version-controlled files.
- **CSRF.** Interactive OAuth enforces `state` both at the callback server and again
  in the authenticate step (the stored value must match the returned one).
- **PKCE.** The interactive flow uses `S256` code challenges.
- **Audience binding.** The AS sets the access token's `aud` to the MCP resource's
  canonical URI; the resource validates it as a plain OAuth resource server. A token
  minted for resource X cannot be replayed against resource Y.
- **Origin binding of stored tokens.** Token lookup is origin-checked, preventing a
  token saved for one origin from being presented to another.
- **Assertion validation.** The Resource AS validates the KYA assertion's signature
  against the issuer's JWKS (pinned algorithm), the issuer, the claim shapes, and
  rejects duplicate `jti`s (replay protection).
- **No silent downgrade.** When KYA is advertised, a mint failure surfaces as a hard
  error rather than quietly prompting a human — preventing a downgrade where a
  failing agent flow becomes an interactive one.
- **Issuer tool hiding.** Capability-provider servers' tools are withheld from the
  model's toolset so it can't mint tokens directly and bypass the gateway.
- **Algorithm confusion.** The AS pins verification to a configured asymmetric
  allow-list and rejects `alg: none` and `HS*`, never inferring `alg` from the token
  (*Issuer trust & key handling*; RFC 8725).
- **SSRF / metadata trust.** The client fetches a `resource_metadata` URL only when
  same-origin with the resource (*Discovery & advertisement gate*); the AS fetches JWKS only from a pre-registered
  `jwks_uri` (never one derived from the assertion's `iss`) with egress limits and
  timeouts (*Issuer trust & key handling*).
- **Replay at scale.** The `jti` store is shared and atomic across AS instances; a
  per-process set does not prevent replay behind a load balancer (*Replay protection & clock skew*).
- **PII.** `hid.email` is personal data. Deployments should prefer a stable pseudonymous
  `sub` over raw email, gate `hid.email` behind a scope/claim, and bound retention of
  `jti`/audit records (the standards & hardening section).
- **Abuse controls.** The `/token` exchange and JWKS fetches are rate-limited per
  issuer and per agent identity; the endpoint is unauthenticated, so it is a
  brute-force/DoS surface (the standards & hardening section).

---

## 19. Conformance Scenarios

A correct integration produces these outcomes:

- **KYA happy path:** the AS advertises the KYA profile, a configured issuer is
  enabled, and consent is given → the agent mints, exchanges, and connects with a
  Bearer access token, no browser.
- **No KYA advertised:** the AS omits the KYA grant profile → the agent falls back to
  interactive Authorization Code + PKCE.
- **KYA advertised, no issuer configured:** the agent falls back to interactive
  Authorization Code + PKCE. (A configured-but-disabled issuer instead fails with a
  prompt to enable it; a genuine mint failure fails with a clear KYA error.)
- **Stale token:** once the MCP server rejects the access token with a `401`, the
  agent re-mints rather than reusing it.
- **Negative cases:** an assertion with `alg: none`/`HS*`, a wrong `iss`, an expired
  `exp`, a replayed `jti`, or a `resource`/`aud` mismatch is rejected with the
  appropriate error (*Token-endpoint error responses*) and mints no token.

---

## 20. Standards Status, Delegation & Productionization

This section records where the reference profile diverges from, or has not yet adopted,
standards a general-purpose authorization server (an Okta/Auth0/Ping/Entra-class IdP)
would require. These are **hardening recommendations and open issues**, distinct from
the reference behavior described above.

### 20.1 Standards positioning

- **Unregistered identifiers.** `authorization_grant_profiles_supported`, the URN
  `urn:ietf:params:oauth:grant-profile:kya`, and the `kya+jwt` media type are not
  IANA-registered. Until they are, treat them as vendor/experimental and prefer a
  clearly-namespaced field/URN; register the assertion media type (e.g.
  `application/kya+jwt`) and emit the issued access token as `at+jwt` (RFC 9068).
- **RFC 7523 vs RFC 8693.** Plain RFC 7523 jwt-bearer requires the assertion `aud` to
  be the AS, and has no slots for a target resource, an actor token, or a requested
  token type. This flow needs all three. Modeling the exchange as **RFC 8693 token
  exchange** (`subject_token` = the KYA assertion, `subject_token_type` = a KYA token
  type URN, `resource` = the MCP URI, `requested_token_type` = access token) is the
  standards-aligned shape and the basis of the IETF identity-chaining / ID-JAG drafts.
  If 7523 is kept, document it as a constrained profile and pin the relaxed-`aud` rule
  explicitly.
- **Mandatory `aud` (hardening).** The reference leaves the assertion `aud` optional and
  overloads it for seller identity. A production IdP should make `aud` validation
  **mandatory and bound to the AS's own identity** (RFC 7523 §3), carrying seller
  identity solely in `sdm`/`ssi`, to prevent audience-confusion/token-substitution
  across tenants.

### 20.2 Delegation vs impersonation

The reference stamps `sub ← hid.email`, collapsing "agent acting for a human" into the
human's identity (impersonation) and erasing the agent from the issued token. A
production deployment should model **delegation** per RFC 8693 §4.1: `sub` = a stable
pseudonymous human identifier, plus `act = { sub: <agent id from aid> }` so the resource
and audit logs see both principal and actor, and `may_act` constraints attest which
agents may act for which humans. This preserves non-repudiation and least privilege.

### 20.3 Trust, scope, and lifecycle

- **Issuer trust.** Per-tenant issuer allow-listing with pinned `jwks_uri` (*Issuer trust & key handling*) is
  the multi-tenant trust anchor; "expected issuer is hardcoded" does not scale.
- **Scope governance.** Replace "AS assigns a default scope" with least-privilege:
  allow a requested `scope`/`resource`, intersect with what the issuer/agent is
  permitted and the human's authority, and default to the minimum.
- **Revocation & introspection.** Add RFC 7009 revocation (to kill a compromised agent
  token mid-life) and optionally RFC 7662 introspection for opaque tokens; consider
  having clients honor `expires_in` (proactive re-mint with a pre-expiry guard, as the
  payment path already does) rather than relying solely on resource `401`s.

### 20.4 Operability

- **Versioning.** Version the profile identifier (e.g. `…:grant-profile:kya:1`).
- **Observability.** Emit a per-exchange audit record (issuer, `jti`, subject, actor,
  resource, decision, reason — PII-aware per *Security Considerations*) and metrics (mint latency,
  failure-by-reason keyed to *Token-endpoint error responses*, replay hits).
- **Conformance.** Ship test vectors covering *Conformance Scenarios*'s scenarios plus the negative cases,
  so partners can self-certify.
