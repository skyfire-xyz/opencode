# Skyfire Agentic Commerce Gateway

An autonomous **catch-and-resolve payment gateway** built on top of opencode's MCP
layer. An LLM agent shops and buys from a merchant MCP server, and a gateway inside
opencode transparently mints and injects a payment token from a Skyfire wallet MCP
server. **The LLM never sees the payment token, the issuer, or the issuer's tools.**
It only ever sees the products and the final "order confirmed."

This directory is the demo harness (a mock merchant + verification scripts). The
gateway itself lives in opencode core (see [File map](#file-map)).

---

## The "capabilities" extension

The gateway is driven by a small extension to opencode's MCP config: an optional
`capabilities` array on any MCP server.

```jsonc
"skyfire": {
  "type": "remote",
  "url": "http://localhost:4000/mcp",
  "headers": { "skyfire-api-key": "<key>" },
  // Settlement-type URIs this server can fulfill, mapped to the tool that mints the token.
  "capabilities": {
    "org.kyapay:pay": { "tool": "create-pay-token" }
  }
}
```

- The field is defined on both `Local` and `Remote` configs in
  [`packages/opencode/src/config/mcp.ts`](../packages/opencode/src/config/mcp.ts).
- `buildCapabilityMap` folds all servers into a `{ capability → { server, tool } }` map,
  and `findProviderForSettlement` does **longest-prefix matching** on the `:`-delimited
  URI (so `org.kyapay:kya-pay:card` matches before falling back to `org.kyapay`). Both
  live in [`gateway.ts`](../packages/opencode/src/mcp/gateway.ts).
- A server that declares `capabilities` is treated as payment **infrastructure**: its
  tools (`create-pay-token`, `find-sellers`, …) are **hidden from the agent's tool
  catalog** via the `providerServers` filter in
  [`mcp/index.ts`](../packages/opencode/src/mcp/index.ts). The gateway still reaches it
  internally — so the LLM cannot bypass the gateway and mint tokens itself.

---

## Architecture

```text
┌─────────┐   tool call    ┌──────────────┐   payments/* signal   ┌──────────────┐
│  LLM /  │ ─────────────▶ │   Gateway    │ ◀──── isError:true ── │   Merchant   │
│  agent  │ ◀───────────── │ (opencode)   │                       │  MCP server  │
└─────────┘  final result  └──────┬───────┘                       └──────────────┘
                                  │ mint token (hidden from LLM)
                                  ▼
                           ┌──────────────┐   /api/v1/tokens    ┌──────────────┐
                           │   sky-mcp    │ ──────────────────▶ │  Skyfire API │
                           │  :4000 proxy │                     │  (backend)   │
                           └──────────────┘                     └──────────────┘
```

**Actors:**

| Component                                                                                         | Role                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Merchant MCP server** ([`merchant.js`](merchant.js))                                            | Sells products. `checkout`/`pay` return `isError:true` + a `payments/*` `_meta` signal describing what payment they need.                                |
| **Skyfire wallet MCP server** (`sky-mcp`, port `4000`)                                            | Mints payment tokens. It is a thin proxy to the Skyfire **backend API** at `API_HOST` (default `http://localhost:3000`, prod `https://api.skyfire.xyz`). |
| **The gateway** (`executeWithGateway` in [`gateway.ts`](../packages/opencode/src/mcp/gateway.ts)) | Intercepts every MCP tool call, catches payment signals, resolves them autonomously, and retries.                                                        |

---

## The catch-and-resolve flow

1. LLM calls a merchant tool (e.g. `pay`) with ordinary args.
2. Merchant rejects with `isError: true` and a `payments/*` block in `_meta` (accepted
   settlement types, total, currency, seller identity).
3. Gateway parses the signal (`parsePaymentSignal`) and matches a settlement type to a
   capability-providing server (`findProviderForSettlement`).
4. Gateway resolves the **seller service id** — preferring the one the merchant
   advertised, otherwise looking it up via the issuer's `find-sellers`
   (`resolveSellerServiceId`).
5. Gateway calls the issuer's token tool (`create-pay-token` /
   `create-kya-payment-token`), extracts the JWT, and **caches** it keyed by
   `(settlementType, total, currency)`.
6. Gateway **retries the original tool** with `payments/settlement/token` injected into
   `_meta`.
7. The LLM receives only the final success. It never saw the signal, the issuer, or the
   token.

> **Note on `checkout` vs `pay`:** in the mock merchant, `checkout` is informational and
> _never_ consumes a token, so retrying it just re-returns the payment signal. `pay` is
> the tool that actually settles. Steer the agent toward "pay for it" so it lands on
> `pay`.

---

## The `payments/*` `_meta` protocol

**Keys the merchant emits** in the payment signal:

| Key                                     | Meaning                                            |
| --------------------------------------- | -------------------------------------------------- |
| `payments/settlement/types`             | Array of settlement-type URIs the merchant accepts |
| `payments/settlement/currency`          | Currency (e.g. `"USD"`)                            |
| `payments/amount/total`                 | Order total — becomes the minted token amount      |
| `payments/amount/sub-total`             | Subtotal                                           |
| `payments/amount/taxes`                 | Taxes                                              |
| `payments/amount/shipping_and_handling` | Shipping                                           |
| `payments/settlement/seller_service_id` | The merchant's Skyfire seller id                   |
| `payments/settlement/seller_search`     | Search hint for `find-sellers` fallback            |

**Keys the gateway injects** when it retries the original tool:

| Key                            | Meaning                                       |
| ------------------------------ | --------------------------------------------- |
| `payments/settlement/type`     | The single settlement type that was fulfilled |
| `payments/settlement/token`    | The minted JWT payment token                  |
| `payments/amount/total`        | Echoed total                                  |
| `payments/settlement/currency` | Echoed currency                               |

`_meta` is forwarded by the MCP SDK's `callTool` (it lives in `BaseRequestParamsSchema`
as a `looseObject`, so custom keys survive validation) and surfaces on the server as
`extra._meta`.

---

## What the LLM does / does not see

**Sees:** the merchant's tool catalog (`search-for-products`, `product-details`,
`add-to-cart`, `checkout`, `pay`), normal results, and the final order confirmation.

**Never sees:**

- The `payments/*` signal — consumed inside the gateway.
- That an issuer exists, or that a token tool was called — those tools are filtered out
  of the catalog (`providerServers` in `mcp/index.ts`).
- The JWT itself — extracted and injected into `_meta`, never placed in `content`.
- The capability/settlement routing or any browser-mandate URL.

---

## Setup

### 1. Configure opencode

[`.opencode/opencode.jsonc`](../.opencode/opencode.jsonc) wires the two servers. The
`skyfire` server declares `capabilities` and the merchant runs locally:

```jsonc
{
  "mcp": {
    "skyfire": {
      "type": "remote",
      "url": "http://localhost:4000/mcp",
      "headers": { "skyfire-api-key": "<your-key>" },
      "capabilities": {
        "org.kyapay:pay": { "tool": "create-pay-token" },
      },
    },
    "merchant": {
      "type": "local",
      // Path is relative to packages/opencode/ (opencode's CWD), not the repo root.
      "command": ["node", "../../merchant-mcp/merchant.js"],
    },
  },
}
```

### 2. Start the Skyfire wallet MCP server pointed at a live backend

`sky-mcp` is a proxy; it must point at a reachable Skyfire backend via `API_HOST`
(it defaults to `http://localhost:3000`, which is usually nothing). For prod:

```bash
cd /path/to/sky-mcp
API_HOST="https://api.skyfire.xyz" node --enable-source-maps build/server.js
```

### 3. Provide a real seller id and a funded wallet

- `SELLER_SERVICE_ID` in [`merchant.js`](merchant.js) must be a **real Skyfire seller
  id** (discover one via `find-sellers`). The mock merchant has no directory entry of
  its own, so it borrows a registered (sandbox) seller's identity.
- The buyer wallet behind your API key must have **balance** to mint a token — minting
  fails with `402` otherwise.

---

## Run the demo

From the repo root (so opencode picks up `.opencode/opencode.jsonc`):

```bash
bun dev --print-logs
```

In the TUI:

1. Run `/mcp` and confirm both `skyfire` and `merchant` are **connected**. Skyfire's
   tools will _not_ appear in the agent's tool list — that's intended.
2. Prompt the agent (phrase it toward `pay`):

   > Find a GPU compute product, add one to my cart, and pay for it. Ship to 123 Demo
   > St, San Francisco, CA 94102.

3. Watch two surfaces: the **chat** reports `Order confirmed … Status: PAID`; the
   **logs** show the hidden work — `caught payment signal` → `calling token issuer` →
   `acquired and cached token` → `retrying original tool with payment token`.

### Standalone checks (no LLM)

```bash
# Merchant only — verifies the payment signal + token-in-_meta flow with a fake token.
node merchant-mcp/test-flow.js

# Live end-to-end issuer check — validates the key, lists real sellers, and mints a
# real token. Pass a search term to exercise the seller lookup.
node merchant-mcp/verify-skyfire.mjs "GPU compute"
# Override target/key via env:
SKYFIRE_URL="http://localhost:4000/mcp" SKYFIRE_API_KEY="<key>" node merchant-mcp/verify-skyfire.mjs
```

`verify-skyfire.mjs` is the fastest way to confirm the backend is reachable and the
wallet can mint **before** launching the TUI.

---

## Troubleshooting

| Symptom                                                                            | Cause                                                                                                                                  | Fix                                                                                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Every authenticated call returns **`API Error`**, but `get-current-datetime` works | `sky-mcp` can't reach the Skyfire **backend** (`API_HOST` / `:3000` is down or wrong). The MCP server is healthy; the upstream is not. | Set `API_HOST` to a live backend (`https://api.skyfire.xyz`) and restart `sky-mcp`.                            |
| Token mint fails with **`402 … Insufficient balance`**                             | Buyer wallet has no funds for the requested amount.                                                                                    | Fund the wallet, or lower the order total below the balance (see [Money model](#money-model)).                 |
| **`Gateway error: … did not return a token. Issuer said: …`**                      | The issuer returned an error in plain text with `isError` unset; the gateway now surfaces that real message.                           | Read the `Issuer said:` detail — it's the upstream reason (often balance or auth).                             |
| Agent calls `skyfire_create-pay-token` / `find-sellers` directly                   | Provider-tool hiding regressed (the `providerServers` filter in `mcp/index.ts`).                                                       | Ensure the skyfire server still declares `capabilities`; confirm its tools are absent from `/mcp`'s tool list. |
| `checkout` loops returning "Payment Required"                                      | `checkout` never consumes a token by design.                                                                                           | Steer the agent to `pay`, which actually settles.                                                              |
| `skyfire` shows **failed** in `/mcp`                                               | The wallet MCP server on `:4000` isn't running.                                                                                        | Start `sky-mcp` (step 2 of Setup).                                                                             |

---

## Money model

Minting a pay token is **not a transfer** — it creates a _claim_ that places a **hold**
(escrow) on the buyer's funds.

- The Skyfire backend records each token as a `claim_v2` with two clocks:
  `tokenExpiresAt` and `holdExpiresAt`, where `holdExpiresAt = tokenExpiresAt +
tokenHoldLeeway`.
- `tokenHoldLeeway` defaults to **86400s (1 day)**, and the token itself lives ~1 hour,
  so a hold lasts roughly **~25 hours**.
- Money only actually moves when the **seller redeems/charges** the claim. If the hold
  expires uncharged, the funds are **released back** to the buyer.

**For this demo:** the mock merchant _never_ redeems — it only decodes the JWT locally
and checks expiry. So minted tokens are held and then released; **money is never
transferred to the seller**. Each mint temporarily reduces _available_ balance by the
order total until the hold expires.

**The gateway's token cache** keys tokens by `(settlementType, total, currency)`, so
re-running the _same_ purchase within the token's ~1-hour life **reuses the existing
token** — no new hold. Repeated identical demo runs are effectively free until the
cached token expires.

> Tip for low balances: shipping and prices in `merchant.js` are tuned so a single-item
> order total stays well under a small test balance (e.g. a $0.13 GPU order against a
> $0.30 wallet).

---

## File map

| Path                                                                                 | What it is                                                                                   |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [`../packages/opencode/src/mcp/gateway.ts`](../packages/opencode/src/mcp/gateway.ts) | The gateway: signal parsing, capability routing, seller resolution, token mint/cache/inject. |
| [`../packages/opencode/src/config/mcp.ts`](../packages/opencode/src/config/mcp.ts)   | The `capabilities` config field (Local + Remote).                                            |
| [`../packages/opencode/src/mcp/index.ts`](../packages/opencode/src/mcp/index.ts)     | Wires the gateway into tool execution; hides provider-server tools from the agent.           |
| [`merchant.js`](merchant.js)                                                         | Mock merchant MCP server (catalog, cart, `checkout`/`pay`, payment signal).                  |
| [`verify-skyfire.mjs`](verify-skyfire.mjs)                                           | Standalone check: key validity, seller lookup, live token mint.                              |
| [`test-flow.js`](test-flow.js)                                                       | Standalone merchant E2E (payment signal + token-in-`_meta`).                                 |
| [`run-flow.js`](run-flow.js)                                                         | Scripted walk-through of the buy flow (simulated gateway).                                   |
| [`../.opencode/opencode.jsonc`](../.opencode/opencode.jsonc)                         | Active opencode config wiring skyfire + merchant.                                            |
| [`opencode.example.jsonc`](opencode.example.jsonc)                                   | Annotated example config.                                                                    |
