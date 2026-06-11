# Agentic Commerce Flow — KYA Auth + PAY Settlement

This documents the end-to-end flow wired into this branch: an agent connects to a
**protected merchant MCP server**, authenticates silently with a **KYA token**, then
makes a purchase that is settled transparently with a **PAY token** — all without the
LLM ever seeing tokens or talking to the payment network.

Two independent layers, two different moments:

| Layer | Question it answers | When it runs | Token | Driven by |
|-------|--------------------|--------------|-------|-----------|
| **KYA** (Know Your Agent) | "Who is this agent — may it *connect*?" | at **connect time** | KYA assertion → OAuth access token | `trySilentKya` in [mcp/index.ts](../packages/opencode/src/mcp/index.ts) |
| **PAY** | "Settle *this purchase*." | at **tool-call time** | PAY token (JWT) | `executeWithGateway` in [mcp/gateway.ts](../packages/opencode/src/mcp/gateway.ts) |

The LLM only ever sees the merchant's plain commerce tools (`search-for-products`,
`add-to-cart`, `checkout`, `pay`). The Skyfire issuer is hidden from the tool catalog
(`providerServers` filter in `tools()`), and tokens move out-of-band.

---

## Cast

- **LLM** — calls merchant tools (search / cart / checkout / pay).
- **opencode MCP client** — the transport + `McpOAuthProvider` (attaches the Bearer token on every request).
- **Gateway** (`executeWithGateway`) — wraps every merchant tool call; intercepts payment signals.
- **Merchant** ([merchant.js](merchant.js)) — protected MCP resource (`:8787`) **and** its own mock OAuth Authorization Server (`:8788`).
- **Skyfire issuer** (`skyfire`, remote MCP) — mints KYA tokens (`create-kya-token`) and PAY tokens (`create-pay-token`). Authenticates with its `skyfire-api-key` header. Hidden from the LLM.

---

## Phase 1 — KYA auth (connect time)

Triggered when the user enables the merchant in the MCP picker (on-demand model) →
`MCP.connect("merchant")`. **No `_meta` here — this layer is pure OAuth/JWT over HTTP.**

```
opencode                merchant (:8787 MCP / :8788 AS)         skyfire issuer
   │                            │                                     │
   │ 1. POST /mcp (no token)    │                                     │
   │ ─────────────────────────► │                                     │
   │ ◄───── 401 + WWW-Authenticate (resource_metadata=…)              │
   │                            │                                     │
   │ 2. GET /.well-known/oauth-protected-resource                     │
   │ ─────────────────────────► │  { authorization_servers:[:8788],   │
   │ ◄──────────────────────────   seller_service_id:"662a…" }        │
   │                            │                                     │
   │ 3. GET :8788/.well-known/oauth-authorization-server              │
   │ ◄──────  { token_endpoint, authorization_grant_profiles_supported:[…kya…] }
   │                            │                                     │
   │ 4. KYA advertised → call issuer create-kya-token                 │
   │    (seller = seller_service_id from step 2)                      │
   │ ───────────────────────────────────────────────────────────────► │
   │ ◄───────────  "…token … <KYA assertion JWT>"                      │
   │                            │                                     │
   │ 5. POST :8788/token  grant_type=urn:…:jwt-bearer & assertion=<JWT>│
   │ ─────────────────────────► │ (verifies assertion vs Skyfire JWKS  │
   │ ◄──────  { access_token }     via jose, issues access token)      │
   │                            │                                     │
   │ 6. store access token (McpAuth, keyed by origin) → retry /mcp     │
   │    with Bearer → 200 → CONNECTED                                  │
```

Key points:
- **Discovery chain** = RFC 9728 (protected-resource metadata) → RFC 8414 (AS metadata) → check `authorization_grant_profiles_supported` for the KYA profile. See `trySilentKya` + helpers in [mcp/kya.ts](../packages/opencode/src/mcp/kya.ts).
- **Seller selection** (which seller the KYA token is minted for) priority: `OPENCODE_KYA_SELLER_SERVICE_ID` env override → `seller_service_id` advertised in the merchant's protected-resource metadata → localhost placeholder. The merchant advertises its own id so no env var is needed.
- After step 6 the access token lives in `McpAuth` and `McpOAuthProvider.tokens()` attaches it as `Authorization: Bearer …` on **every** subsequent merchant request — including all the PAY-phase tool calls below.
- If KYA is advertised but minting fails, connect **fails loudly** (no silent fallback to interactive OAuth unless `OPENCODE_KYA_INTERACTIVE_FALLBACK=1`).

---

## Phase 2 — PAY settlement (tool-call time)

Now connected, the LLM shops. `search-for-products` / `add-to-cart` pass straight through
the gateway. The interesting part is `checkout` → `pay`, where **`_meta` carries everything**.

```
LLM        gateway (executeWithGateway)      merchant            skyfire issuer
 │ checkout    │                               │                      │
 │ ───────────►│ call checkout ───────────────►│                      │
 │             │ ◄── isError:true + _meta ──────┤  ← PAYMENT SIGNAL (A)│
 │             │                                │                      │
 │             │ parsePaymentSignal → match settlement type to a       │
 │             │ capability provider (org.kyapay:pay → skyfire)        │
 │             │                                │                      │
 │             │ resolve sellerServiceId (from signal, else find-sellers)
 │             │ call create-pay-token + _meta ──────────────────────►│ (B)
 │             │ ◄──────────  "… <PAY token JWT>"  (or mandate _meta)  │ (C)
 │             │ extract + cache token                                 │
 │             │                                │                      │
 │             │ RETRY pay with _meta (token) ─►│  ← settles (D)       │
 │             │ ◄──── "Order confirmed … PAID" ┤                      │
 │ ◄───────────┤ return final result to LLM     │                      │
```

The LLM sees only its `checkout` call and the final `Order confirmed`. Steps in the
middle (B, C, the retry) are invisible to it.

---

## `_meta` reference — the contract

All payment coordination rides on the MCP `_meta` field. There are **four** `_meta` payloads.

### (A) Merchant → gateway: the **payment signal**
Returned by `checkout` (and by `pay` when no token is present yet) as `{ isError: true, _meta: {…} }`.
`isError:true` is the trigger — `parsePaymentSignal` ignores non-error results.

| `_meta` key | Type | Meaning |
|-------------|------|---------|
| `payments/settlement/types` | `string[]` | Accepted settlement types, e.g. `["org.kyapay:kya-pay:card","org.kyapay:pay:card"]`. **Required** (must be a non-empty array, or no signal). |
| `payments/amount/total` | `number` | Order total. **Required** (must be a number). |
| `payments/settlement/currency` | `string` | Defaults to `"USD"` if absent. |
| `payments/amount/sub-total` | `number?` | Optional. |
| `payments/amount/taxes` | `number?` | Optional. |
| `payments/amount/shipping_and_handling` | `number?` | Optional. |
| `payments/settlement/seller_service_id` | `string?` | Merchant's Skyfire identity; the issuer needs it to mint. |
| `payments/settlement/seller_search` | `string?` | Fallback search hint if no id (gateway calls `find-sellers`). |

> The gateway matches a settlement type to a provider by **longest-prefix** on `:` — e.g. `org.kyapay:pay:card` matches the configured capability `org.kyapay:pay` → `{ server: skyfire, tool: create-pay-token }`.

### (B) Gateway → issuer: **mint request** (`create-pay-token`)
Sent as tool `arguments: { amount, sellerServiceId }` plus `_meta`:

| `_meta` key | Notes |
|-------------|-------|
| `payments/amount/total` | always |
| `payments/settlement/currency` | always |
| `payments/amount/sub-total` | if present in (A) |
| `payments/amount/taxes` | if present in (A) |
| `payments/amount/shipping_and_handling` | if present in (A) |

### (C) Issuer → gateway: optional **inline mandate** (browser approval)
If the issuer needs human approval, its token result carries:

| `_meta` key | Type | Meaning |
|-------------|------|---------|
| `payments/mandates/inline/required` | `true` | Approval needed. |
| `payments/mandates/inline/url` | `string` | URL the gateway opens in a browser; it returns "please retry after authorizing." |

Otherwise the PAY token JWT is parsed out of the result's text content (`extractJwtFromText`)
and cached keyed by `settlementType:total:currency` (honoring the JWT `exp`, 30s buffer).

### (D) Gateway → merchant: **retry with token**
The original `pay` call is re-issued with the token injected in `_meta`:

| `_meta` key | Meaning |
|-------------|---------|
| `payments/settlement/type` | The matched settlement type (e.g. `org.kyapay:pay:card`). |
| `payments/settlement/token` | The PAY token JWT. |
| `payments/amount/total` | Echoed for the merchant. |
| `payments/settlement/currency` | Echoed for the merchant. |

The merchant reads these from the incoming request as `params._meta["payments/settlement/token"]`
and `params._meta["payments/settlement/type"]` ([merchant.js](merchant.js), `pay` handler),
validates the token (decodes JWT, checks `exp`), clears the cart, and returns `Status: PAID`.

> **Two `_meta` directions, easy to confuse:** in (A) and (C) `_meta` flows *out* of a tool
> result (server → caller). In (B) and (D) `_meta` flows *in* as part of the request
> `params` (caller → server). Over JSON-RPC the request form lands at `params._meta`, which
> is why the merchant reads the pay token there.

---

## Config & how the issuer stays hidden

[.opencode/opencode.jsonc](../.opencode/opencode.jsonc):
```jsonc
"merchant": { "type": "remote", "url": "http://127.0.0.1:8787/mcp" },   // consumer, no capabilities
"skyfire":  {
  "type": "remote", "url": "https://mcp-qa.skyfire.xyz/mcp",
  "capabilities": {
    "org.kyapay:kya": { "tool": "create-kya-token" },   // used by KYA auth (Phase 1)
    "org.kyapay:pay": { "tool": "create-pay-token" }     // used by PAY gateway (Phase 2)
  },
  "headers": { "skyfire-api-key": "…" }
}
```
- Because `skyfire` declares capabilities it lands in `providerServers` and is **filtered out of the LLM's tool catalog** — the LLM can't call `create-pay-token`/`create-kya-token` directly and bypass the gateway.
- `merchant` declares no capabilities, so its tools stay visible to the LLM.

---

## Running it

```bash
cd merchant-mcp && npm install && npm start     # merchant on :8787 (MCP) + :8788 (OAuth AS)
```
Set `skyfire-api-key` in `.opencode/opencode.jsonc`, launch opencode, then **enable both
`merchant` and `skyfire`** in the MCP picker:
- enabling `merchant` runs KYA auth (Phase 1) → connected;
- enabling `skyfire` connects the issuer so the gateway can mint PAY tokens (Phase 2).

Then ask the agent to show products → add to cart → checkout → pay.

Trace it in the log (`~/.local/share/opencode/log/dev.log`):
- Phase 1: `===== KYA auth flow BEGIN =====` … `token exchange success` … `{ minted: true }`
- Phase 2: `gateway: matched settlement type` … `gateway: acquired and cached token` … `gateway: retrying original tool with payment token`
