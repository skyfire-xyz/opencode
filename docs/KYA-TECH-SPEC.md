# KYA + OAuth + MCP Integration — Technical Specification

How an autonomous agent authenticates to a protected MCP server by exchanging a
**KYA (Know Your Agent) assertion** for an OAuth access token, what that assertion
contains, and **which fields the Authorization Server validates** before minting the
token. It also covers when the agent falls back to interactive OAuth and how the same
machinery mints payment tokens (`org.kyapay:pay`). The doc is independent of any
particular client implementation.

The heart of the integration is the **KYA → OAuth token exchange** (§7.4–§7.6):
how the assertion is minted, the RFC 7523 jwt-bearer request that exchanges it, and
the per-field validation the AS performs. The assertion-validation algorithm follows
Skyfire's published KYA token-verification reference.

---

## 1. Purpose & Background

MCP (Model Context Protocol) remote servers are HTTP resources that may require
OAuth 2.1 authorization. The standard flow for an unauthenticated server is the
interactive **Authorization Code + PKCE** flow: open a browser, the user
consents, an authorization code returns to a loopback redirect, and the code is
exchanged for an access token.

That flow assumes a _human_ is present to consent. An autonomous agent has no
browser session to drive, so it needs a **non-interactive** way to obtain an
access token in which the **agent's identity** (not a human's browser session)
is what the resource server authorizes. That is what **KYA** provides:

1. A trusted **issuer** mints a signed **KYA assertion** (a JWT) attesting to the
   agent's identity and the seller it wants to act against. (Skyfire's MCP server
   is the issuer in the reference deployment.)
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
That sibling feature is documented in §12.

---

## 2. Terminology & Actors

| Term                      | Meaning                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent**                 | The autonomous MCP client that connects to remote MCP servers on a user's behalf.                                                                                                      |
| **MCP server / Resource** | The protected remote MCP server the agent wants to use. A plain OAuth 2.1 resource server.                                                                                             |
| **Resource AS**           | The OAuth Authorization Server protecting the resource. Hosts discovery metadata + the `/token` endpoint.                                                                              |
| **KYA Issuer**            | A remote MCP server advertising capability `org.kyapay:kya` and exposing a tool (e.g. `create-kya-token`) that mints KYA assertions. Skyfire's MCP server in the reference deployment. |
| **KYA assertion**         | A signed JWT minted by the issuer, attesting agent identity + seller. _Not_ an OAuth access token.                                                                                     |
| **Access token**          | A normal OAuth 2.1 Bearer token issued by the Resource AS in exchange for the assertion.                                                                                               |
| **Capability**            | A URI like `org.kyapay:kya` or `org.kyapay:pay` declared in config, mapped to the issuer tool that fulfills it.                                                                        |
| **Seller selector**       | The argument passed to the issuer tool identifying the seller: either `sellerServiceId` (a UUID) or `sellerDomainOrUrl` (a hostname).                                                  |

**Relevant RFCs / specs:**

- **RFC 9728** — OAuth 2.0 Protected Resource Metadata (`/.well-known/oauth-protected-resource`).
- **RFC 8414** — OAuth 2.0 Authorization Server Metadata (`/.well-known/oauth-authorization-server`).
- **RFC 7523** — JWT Profile for OAuth Client Authentication and Authorization Grants (`grant_type=…:jwt-bearer`).
- **RFC 7591** — OAuth 2.0 Dynamic Client Registration (used only in the interactive fallback).
- **RFC 7636** — PKCE (interactive fallback).
- **KYA / ID-JAG grant profile drafts** — advertised via `authorization_grant_profiles_supported` in AS metadata; profile URN `urn:ietf:params:oauth:grant-profile:kya`.

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
  "capabilities": { /* … */ }           // optional, see §5
}
```

Optional OAuth sub-config (used by the interactive fallback):

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
    "skyfire": {
      "type": "remote",
      "url": "https://mcp.skyfire.xyz/mcp",
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
never enters the KYA branch — you don't mint a KYA token to talk to the KYA
issuer (see §7.1).

> **Security:** API keys must never be committed. Use environment interpolation
> (e.g. `{env:SKYFIRE_API_KEY}`) and supply the secret at runtime.

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
  `skyfire`, but any name works.
- **Tool resolution** uses `capabilities["org.kyapay:kya"].tool`. If that is
  empty or missing, the server is **not** treated as an issuer.
- **First match wins** — if multiple servers advertise KYA, configuration order
  decides.

### 5.3 The capability map (for payments) and issuer hiding

A capability map `{ [capabilityURI]: { server, tool } }` is built across all
configured servers. It drives two things:

- **Payment routing** (§12), and
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
  minting (§6.3).
- **Needs interactive auth** — auth is required but KYA isn't available (not advertised,
  or the fallback applies), so the standard interactive OAuth flow is used instead.
- **Failed** — connection or KYA minting failed; carries an error.

(A server that demands a pre-registered OAuth client but offers no dynamic client
registration is a distinct failure — see §10.)

### 6.2 KYA is triggered reactively

KYA is never performed proactively. It is triggered by an **authorization challenge**
from the protected server — a `401` (or an auth-required tool result) — which arrives
either when the client first connects or on the first protected tool call (§6.5). A
client that already holds a valid access token for the server skips KYA entirely.

### 6.3 Entry point, consent, and the issuer gate

KYA has **two** entry points that share the same mint machinery (§7), differing only
in _when_ the challenge arrives:

- **Connect-time** — the handler that fires when a transport connect returns an
  **Unauthorized (401)** and the guards in §7.1 pass (described in this section).
- **Tool-call-time** — a 401 (or an auth-required tool result) on a _later_ tool call,
  after the agent has already connected unauthenticated (see §6.5).

The connect-time handler drives detection, the consent gate, the issuer check, and the
mint. Connecting a KYA-protected server therefore takes two passes:

1. **First connect (no consent).** The handler runs discovery (§7.2). If the
   server advertises KYA, it stops to **await KYA consent** rather than minting —
   KYA carries the agent's identity, so the user approves it explicitly before
   any token is minted.

2. **Reconnect with consent.** The client reconnects with a consent flag. This
   time the handler passes the consent check and proceeds to the **issuer gate**:
   the configured KYA issuer must itself be enabled (connected). If it isn't, the
   connect fails with a message telling the user to enable it — connecting the
   issuer is what validates its config and API key, and this keeps KYA from
   minting through an issuer the user never enabled. (This mirrors the payment
   gateway, which only mints through a connected provider — §12.) With the issuer
   enabled, the handler runs the silent KYA flow (§7) and retries the transport on
   success.

### 6.4 Transport selection

MCP defines two HTTP transports — **Streamable HTTP** and the older **SSE**. A client
that supports both should treat a `401` on the Streamable-HTTP attempt as "this server
speaks HTTP and needs auth" and **not** fall back to SSE (which would typically 404 and
mask the real auth/KYA failure). KYA is attempted on the Streamable-HTTP path. After a
successful mint the client retries the connection; the stored access token is now sent
on the request (see §8 for how the token is stored and presented).

### 6.5 Tool-call-time challenge

A server need not reject the _connection_. It can accept an unauthenticated connect —
`initialize`, `tools/list`, and any **open** tools all succeed with no token — and
challenge only when a **protected** tool is called. The agent handles this lazily, in
the wrapper around each tool's `execute`:

- If a tool call surfaces an auth failure **and** the server advertises KYA, the agent
  runs the same silent KYA flow (§7) and, on success, **retries that same tool call**
  with the now-stored Bearer token. The result of the retry is returned to the model.
- The failure is recognized two ways, because servers signal it differently:
  - a **thrown 401** — `UnauthorizedError`, or an error carrying `code === 401` /
    a `401`/`unauthorized` message; or
  - a **tool result flagged `isError`** whose text indicates auth is required
    (`unauthorized`, `forbidden`, `401`, `sign-in`, `kya`, …). Detecting this form
    matters because some resources return a normal `200` result flagged `isError`
    with a sign-in message instead of a transport 401.
- The mint goes through the same **enabled-issuer gate** as the connect-time path
  (§6.3): no usable issuer → the call is gated with a sign-in message rather than
  silently failing. The §7.1 conditions apply equally; the tool-call path keys off KYA
  advertisement (§7.2) plus the issuer gate.
- The stored token is reused for the rest of the session, so subsequent protected
  calls don't re-challenge.

A single server can therefore mix open and protected tools, and KYA fires the moment
the agent first touches a protected one — not necessarily at connect.

---

## 7. The Silent KYA Flow

The flow resolves to one of three outcomes, and whether KYA was **advertised** (§7.2)
decides how a failure is handled (§9):

- **Minted** — discovery, mint, and exchange all succeeded; the access token is stored.
- **Not advertised** — the AS doesn't offer the KYA grant profile, so KYA is skipped
  and the caller may fall back to interactive OAuth.
- **Advertised but failed** — KYA was offered but minting/exchange failed. This is a
  hard failure: it must **not** silently degrade to interactive OAuth (§9, §7.7).

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

Discovery is shared by both the consent gate (§6.3) and the mint preflight. It
yields `{ supportsKya, authServer, sellerServiceId }`:

1. **Probe.** `POST <serverUrl>` with a minimal JSON-RPC `initialize` body
   and no `Authorization`. If the response is `401`, read the
   `resource_metadata="…"` pointer from the `WWW-Authenticate` header (RFC 9728).
   If there's no 401 or no pointer, fall back to the default well-known location:
   `<origin>/.well-known/oauth-protected-resource`.

2. **Protected-resource metadata.** `GET` the resource-metadata URL. The
   response is expected to contain:
   - `authorization_servers: string[]` → the Resource AS origin (`[0]`).
   - optionally `seller_service_id` → a seller identity the resource advertises for
     itself. If there's no auth server, `supportsKya: false` and the flow
     short-circuits.

3. **AS metadata.** `GET <authServer>/.well-known/oauth-authorization-server`
   (RFC 8414), falling back to `/.well-known/openid-configuration`. Read
   `authorization_grant_profiles_supported` and check whether it advertises the KYA
   profile (normalizing both the full URN `urn:ietf:params:oauth:grant-profile:kya`
   and the short token `kya`).

**The advertisement gate:** if the profiles do not include `kya`, KYA is treated as
**not advertised** — it is skipped and the caller may fall back to interactive OAuth.
Once past this gate, any _subsequent_ failure is treated as **advertised but failed**
(a hard failure — see §7.7).

> All of discovery is wrapped so a discovery/network failure degrades to "KYA not
> advertised," not a hard error.

### 7.3 Seller selector resolution

The issuer tool requires **exactly one** seller selector. Priority:

1. **Explicit override** (a configured `sellerServiceId` UUID) → `{ sellerServiceId }`.
2. **`seller_service_id`** advertised by the protected-resource metadata → `{ sellerServiceId }`.
3. **Derived from the target MCP URL** → `{ sellerDomainOrUrl }`: the target's
   hostname, except **loopback / RFC 1918 private ranges** are substituted with a
   placeholder domain registered in the issuer's seller directory (because the
   directory can't resolve localhost). The recognized "local" set: `localhost`,
   `127.0.0.1`, `::1`, `0.0.0.0`, `*.localhost`, `127.*`, `10.*`, `192.168.*`,
   `172.16–31.*`.

### 7.4 Mint the KYA assertion

1. If no issuer is configured → fail as **advertised but failed** with an error such as
   `KYA supported but no issuer configured…`.
2. Connect to the issuer via a StreamableHTTP transport carrying the issuer's
   `headers` (the API key).
3. `callTool({ name: issuer.tool, arguments: sellerSelector })`, closing the issuer
   client afterward.
4. Concatenate the text content of the result and extract the JWT — a three-segment
   `xxx.yyy.zzz` token. (The issuer tool may return a human-readable string such as
   `"Creation of KYA token for <id> is complete: <jwt>"`.) No JWT → error result.

The result is a signed **KYA assertion** (a JWT) — *not* an access token. It is a
short-lived, issuer-signed attestation of the agent's identity and the seller it
intends to act against. Its claims are exactly what the Resource AS validates during
the exchange (§7.6):

| Claim          | Where   | Meaning                                                                          |
| -------------- | ------- | -------------------------------------------------------------------------------- |
| `alg`          | header  | Signature algorithm — **`ES256`** for Skyfire.                                   |
| `typ`          | header  | Token type, e.g. **`kya+jwt`**.                                                  |
| `iss`          | payload | Issuer — the Skyfire environment origin (`https://app.skyfire.xyz`, `…app-sandbox…`, `…app-qa…`). |
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
to the payment flow (§12), not the auth exchange.

### 7.5 Exchange the assertion for an access token (RFC 7523)

1. **Read the AS `token_endpoint`** from the AS metadata. Missing → error result.
2. `POST <token_endpoint>` with `content-type: application/x-www-form-urlencoded`
   and body:

   ```
   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
   assertion=<KYA JWT>
   ```

   This is the **RFC 7523 JWT-bearer grant**. A non-2xx response is a hard failure
   (`invalid_grant`, …).

   > **The exchange is client-unauthenticated.** The request carries _only_
   > `grant_type` and `assertion` — there is **no** `client_id`/`client_secret`, no
   > `Authorization` header, and **no `scope`**. All trust derives from the
   > issuer-signed assertion, which the AS validates per §7.6. With no scope
   > requested, the AS assigns a default scope.

3. On success the AS returns a standard OAuth token response:

   ```json
   { "access_token": "<jwt>", "token_type": "Bearer", "expires_in": 3600, "scope": "…" }
   ```

   The **access token** is an ordinary OAuth 2.1 bearer credential minted *for this
   resource*: its `aud` is the resource's canonical URI and it carries the resource's
   scope (e.g. `mcp`). The agent presents it as `Authorization: Bearer <access_token>`
   and the MCP server validates it as a plain resource server, with **no KYA
   awareness**. The agent persists **only** `access_token` (keyed by the resource's
   URL origin so the credential layer finds it — §8.1); `expires_in`, `scope`, and any
   `refresh_token` are dropped (§7.8).

### 7.6 What the Resource AS validates (assertion fields & rules)

The exchange's security rests entirely on the AS validating the assertion before it
mints anything. The reference algorithm is Skyfire's published KYA token-verification
example; the steps below match it.

1. **Signature + algorithm + issuer.** Verify the JWS against the issuer's **JWKS**
   (`<iss>/.well-known/jwks.json`), pinning `alg` to **`ES256`** and requiring `iss`
   to equal the expected Skyfire issuer for the target environment. (The JWT library
   also enforces `exp`/`nbf` here.)
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

Any failed step is returned as `invalid_grant` (HTTP `401`/`400`) and **no** access
token is minted. (A signature/JWKS or `iss` mismatch most often means the assertion
was minted for a **different environment** than the AS expects.)

### 7.7 Failure semantics

- If discovery passed the advertisement gate (§7.2), any later failure — issuer
  connect, mint tool call, or token exchange — is an **advertised-but-failed** result.
  This is deliberate: a genuine KYA failure must **not** silently degrade to
  interactive OAuth.
- If KYA was never advertised, the result is simply **not advertised**, and the caller
  may fall back to interactive OAuth.

### 7.8 Lifetime of a KYA-minted token (no local expiry, no refresh)

Because the exchange stores no `expiresAt` and no `refreshToken`:

- The token reads as **authenticated indefinitely** in status checks — even after
  the AS-issued `expires_in` has actually elapsed.
- The agent therefore does **not** proactively re-mint on a timer. A stale token is
  replaced only when the **MCP server rejects it with a 401**, which re-enters the
  connect flow and runs the silent KYA flow again (a fresh mint).
- There is no refresh-token path for KYA tokens; "refresh" is always a full re-mint
  via the issuer.

---

## 8. Client Responsibilities

Whatever OAuth machinery a client uses for the transport (auto-connect and the
interactive flow), it must handle the following.

### 8.1 Origin normalization

Discovery metadata (`/.well-known/*`) lives at the server's **origin**, but MCP
transport URLs often include a `/mcp` path. The client must normalize to the origin
so that (a) discovery doesn't 404 on `/mcp/.well-known/*`, and (b) a token stored by
KYA (keyed by origin) is found again on lookup.

### 8.2 Token & client storage

- **Token read** returns a stored token **only if its origin matches** — preventing
  reuse across a changed URL.
- **Token save** persists access/refresh/expiry/scope (KYA stores only the access
  token — §7.5).
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
band (§7): the client discovers, mints, exchanges, and stores the access token
**before** retrying the transport, so the transport simply finds a valid token. This
keeps the KYA path authoritative and lets the library fall back to interactive
`authorization_code` when KYA is unavailable.

---

## 9. Decision Matrix (Gating Logic)

For an auth-required server where KYA applies (§7.1), the outcome resolves in this
order. "Usable issuer" means an issuer is configured **and** enabled.

| KYA advertised? | Consent given? | Usable issuer?   | Interactive fallback enabled? | Outcome                                  |
| --------------- | -------------- | ---------------- | ----------------------------- | ---------------------------------------- |
| No              | —              | —                | —                             | **Interactive OAuth**                    |
| Yes             | no             | —                | —                             | **Await KYA consent** (user approval)    |
| Yes             | yes            | yes → mint ok    | —                             | **Connected** via Bearer                 |
| Yes             | yes            | yes → mint fails | —                             | **Fail** (clear KYA error)               |
| Yes             | yes            | no               | unset (default)               | **Fail** (enable the issuer, or add one) |
| Yes             | yes            | no               | set                           | **Interactive OAuth**                    |

Rationale: KYA is the intended non-interactive path. Silently dropping to a browser
prompt when KYA was _supposed_ to work would hide real failures, so the default is
"KYA or bust" with an explicit opt-out (the interactive-fallback toggle). Requiring
consent and an enabled issuer keeps minting deliberate and tied to a validated
issuer.

---

## 10. Interactive OAuth Fallback

When the decision matrix (§9) lands on interactive OAuth, the client runs the standard
**Authorization Code + PKCE** flow (RFC 7636) against the same Resource AS:

1. Discover the AS (§7.2) and obtain a client registration if the AS requires one — a
   configured `client_id`, or one from dynamic client registration (RFC 7591).
2. Generate a PKCE verifier/challenge and a random `state`, then open the AS's
   authorization endpoint in a browser.
3. The user authenticates and consents; the AS redirects back to the client's
   **redirect URI** with `code` and `state`.
4. The client **validates `state`** against the value it generated (CSRF defense), then
   exchanges `code` at the token endpoint with the PKCE verifier for an access token.
5. The client stores the token (§11) and connects.

The redirect URI is typically a **loopback** address the client listens on
(`http://127.0.0.1:<port>/…`), per the OAuth native-app guidance. `state` is
mandatory — a missing or unknown `state` on the callback is rejected as a possible CSRF
attack — and a pending request times out if no callback arrives.

> **Loopback limitation:** a loopback redirect lands on the **client's** host, so the
> interactive flow only completes when the browser and the client share a machine,
> unless a non-loopback redirect URI is configured. The KYA flow has no such
> limitation — it involves no browser.

---

## 11. Token Storage

A client persists the access token — and, for the interactive flow, the client
registration and PKCE/CSRF state — so it can reuse them across requests and sessions.
Requirements:

- **Bind tokens to the server origin.** A stored token is returned only for the origin
  it was issued for, so it can't be presented to a different server (§8.1–§8.2).
- **Protect the store.** These are bearer credentials — persist them outside the
  project tree with owner-only permissions.
- **KYA stores only the access token.** The refresh token, scope, and expiry from the
  exchange response are not retained for KYA-minted tokens, which is why such a token
  has no locally tracked expiry and is re-minted only when the server returns a `401`
  (§7.8).

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

The gateway shares the issuer-hiding rule (§5.3): provider servers are excluded
from the model-visible toolset so the model can't call the mint tools directly.

> **KYA vs. pay:** KYA mints an _auth_ assertion to _connect_ to a server; pay mints
> a _payment_ token to _settle a transaction_ with an already-connected server. Both
> go through the same configured issuer; only the capability URI and tool differ.

---

## 13. Configuration Options

Two behaviors are configurable (e.g. via environment), evaluated at access time:

| Option                          | Effect                                                                                                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Seller-service-id override**  | Pins the seller selector to a specific `sellerServiceId` UUID, overriding URL-derived selection.                                                                                                                                                                           |
| **Interactive-fallback toggle** | When enabled, an auth-required server that advertises KYA but has **no configured issuer** falls through to interactive OAuth instead of hard-failing. Does **not** affect the "no KYA advertised" case (always falls back) or the "mint failed" case (always hard-fails). |

---

## 14. Client Surfaces

However a client exposes connect/auth — a UI toggle, an HTTP API, a CLI — it runs the
same detection and consent gate. The surface only needs to:

- start a connection to a server;
- when the server is **awaiting KYA consent**, prompt the user ("Use your KYA identity
  to sign in to _name_?") and, on approval, re-issue the connection with consent so the
  mint proceeds;
- when the server **needs interactive auth**, drive the standard interactive OAuth flow
  (which opens a browser; see the loopback caveat in §10);
- surface connection state and errors back to the user.

The mint, exchange, and validation are identical regardless of surface — only how the
user is prompted and where any browser step lands differ.

---

## 15. Server-Side Requirements

For the exchange to work, the protected MCP server and its Authorization Server must
implement the following (the server-side counterparts to the client flow in §6–§8).

**Protected MCP resource:**

- `GET /.well-known/oauth-protected-resource` (RFC 9728) returning
  `{ resource, authorization_servers: [<AS>], … }`, optionally a `seller_service_id`
  the resource advertises for itself.
- `POST /mcp` — the JSON-RPC endpoint (`initialize`, `tools/list`, `tools/call`). A
  request without a valid Bearer access token gets a `401` with a `WWW-Authenticate`
  challenge advertising the AS:
  `Bearer realm="mcp", resource_metadata="…", authorization-uri="…/.well-known/oauth-authorization-server"`.
  The challenge may come at connect or on the first protected tool call (§6.5).
- Validates the access token as a plain OAuth 2.1 resource server — signature, `iss`,
  `aud` (its own resource URI), `exp`, and required `scope` — with **no KYA awareness**.

**Resource Authorization Server:**

- `GET /.well-known/oauth-authorization-server` (RFC 8414, with
  `/.well-known/openid-configuration` as a fallback) advertising `token_endpoint`,
  `grant_types_supported` (including `urn:ietf:params:oauth:grant-type:jwt-bearer`),
  and the KYA grant profile in `authorization_grant_profiles_supported`
  (`urn:ietf:params:oauth:grant-profile:kya`). Omitting the KYA profile is what makes a
  client fall back to interactive OAuth.
- `POST /token` — the jwt-bearer exchange (§7.5): validate the assertion per §7.6,
  then mint an access token whose `aud` is the resource URI.
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

If the issuer is missing or not enabled, step 7 never happens: the result is `failed`
("enable the issuer, or add one") — unless the interactive-fallback toggle is set, in
which case A falls through to Case 2.

**Case 2 — interactive fallback** (KYA not advertised, or fallback enabled):

```
A  → AS   GET /authorize?response_type=code&code_challenge=…   (browser)
AS → A    302 → redirect_uri?code=…                            (loopback callback)
A  → AS   POST /token  grant_type=authorization_code & code_verifier
AS → A    { access_token }
A  → M    POST /mcp + Authorization: Bearer <access_token>
M  → A    200 OK + tools — connected
```

The steps above show the challenge arriving at connect. The **tool-call-time** variant
(§6.5) is the same mint/exchange, just triggered later: the connect succeeds with no
token, the agent calls open tools normally, and the `401` (or `isError` sign-in result)
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
| KYA advertised, no usable issuer     | Fail with an actionable message                     |
| Issuer returns non-JWT text          | Fail ("could not extract JWT assertion…")           |
| AS metadata missing `token_endpoint` | Fail                                                |
| Token exchange non-2xx               | Fail with status + body                             |
| 401 on Streamable HTTP               | Don't fall back to SSE; take the auth path          |
| Server needs pre-registered client   | Needs client registration (no DCR available)        |
| Interactive: missing/invalid state   | Callback rejected (CSRF)                            |
| Interactive: state mismatch          | Rejected ("OAuth state mismatch")                   |
| Browser won't open                   | Surface the authorization URL for manual opening    |
| Callback timeout                     | Reject after a timeout                              |
| Token bound to wrong origin          | Token lookup returns nothing → re-auth              |

---

## 18. Security Considerations

- **No secrets in the repo.** The issuer's API key is supplied via environment
  interpolation; tokens are stored mode-restricted outside the project tree.
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

---

## 19. Conformance Scenarios

A correct integration produces these outcomes:

- **KYA happy path:** the AS advertises the KYA profile, a configured issuer is
  enabled, and consent is given → the agent mints, exchanges, and connects with a
  Bearer access token, no browser.
- **No KYA advertised:** the AS omits the KYA grant profile → the agent falls back to
  interactive Authorization Code + PKCE.
- **KYA advertised, no usable issuer:** by default the connect fails with an
  actionable error; with the interactive-fallback option enabled it falls through to
  interactive instead.
- **Stale token:** once the MCP server rejects the access token with a `401`, the
  agent re-mints rather than reusing it (§7.8).

---

## 20. Known Limitations

- **Interactive flow is local-only by default.** The loopback redirect lands on the
  agent host. A truly remote client needs a split start → open-in-user-browser →
  callback flow with a client-hosted redirect.
- **Issuer output parsing is regex-based.** The agent scrapes a JWT out of a
  human-readable issuer-tool result. A structured tool result would be more robust.
- **First-issuer-wins.** Multiple KYA issuers aren't disambiguated beyond config
  order.
- **No local expiry tracking or refresh for KYA-minted tokens.** Only the access
  token is stored, so it reads as `authenticated` indefinitely and is re-minted only
  when the MCP server rejects the stale token with a 401. See §7.8.
- **Seller placeholder for local targets.** Loopback/private targets are mapped to a
  placeholder domain; real deployments must register their domain (or pin a
  `sellerServiceId`) in the issuer's seller directory.
