# Skyfire Agentic Commerce Gateway

An autonomous **catch-and-resolve payment gateway** built on top of opencode's MCP
layer. An LLM agent shops and buys from a merchant MCP server, and a gateway inside
opencode transparently mints and injects a payment token from a Skyfire wallet MCP
server. **The LLM never sees the payment token, the issuer, or the issuer's tools.**
It only ever sees the products and the final "order confirmed."

The merchant is also KYA-protected: connecting to it requires a **KYA token** (Know Your
Agent) minted by Skyfire and exchanged for an OAuth access token — all handled silently
by opencode before the agent ever sees a tool.

This directory is the demo harness (a mock merchant + verification scripts). The
gateway itself lives in opencode core (see [File map](#file-map)).

---

## The "capabilities" extension

The gateway is driven by a small extension to opencode's MCP config: an optional
`capabilities` object on any MCP server, mapping capability URIs to the tool that
fulfills them.

```jsonc
"skyfire": {
  "type": "remote",
  "url": "https://mcp-qa.skyfire.xyz/mcp",
  "headers": { "skyfire-api-key": "{env:SKYFIRE_API_KEY}" },
  "capabilities": {
    "org.kyapay:kya": { "tool": "create-kya-token" },
    "org.kyapay:pay": { "tool": "create-pay-token" }
  }
}
```

- The field is defined on both `Local` and `Remote` configs in
  [`packages/opencode/src/config/mcp.ts`](../packages/opencode/src/config/mcp.ts).
- Two capability families are used:
  - **`org.kyapay:kya`** — KYA authentication. The gateway calls `create-kya-token` to
    mint a JWT assertion, exchanges it for an OAuth access token via `jwt-bearer` grant,
    and uses that token to authenticate the MCP connection (handled in
    [`kya.ts`](../packages/opencode/src/mcp/kya.ts)).
  - **`org.kyapay:pay`** — Payment settlement. The gateway calls `create-pay-token` to
    mint a payment JWT when a merchant tool demands payment (handled in
    [`gateway.ts`](../packages/opencode/src/mcp/gateway.ts)).
- `buildCapabilityMap` folds all servers into a `{ capability → { server, tool } }` map,
  and `findProviderForSettlement` does **longest-prefix matching** on the `:`-delimited
  URI (so `org.kyapay:pay:coin` matches before falling back to `org.kyapay`). Both
  live in [`gateway.ts`](../packages/opencode/src/mcp/gateway.ts).
- A server that declares `capabilities` is treated as payment **infrastructure**: its
  tools (`create-pay-token`, `find-sellers`, …) are **hidden from the agent's tool
  catalog** via the `providerServers` filter in
  [`mcp/index.ts`](../packages/opencode/src/mcp/index.ts). The gateway still reaches it
  internally — so the LLM cannot bypass the gateway and mint tokens itself.

---

## Architecture

```text
                                                       ┌──────────────────────┐
                                                       │  Merchant MCP server │
                                                       │   :8787 (HTTP/MCP)   │
                                                       │   :8788 (mock OAuth) │
┌─────────┐   tool call    ┌──────────────┐            └───────┬──────────────┘
│  LLM /  │ ─────────────▶ │   Gateway    │ ◀─── 401 (KYA) ───┘  on connect
│  agent  │ ◀───────────── │ (opencode)   │ ◀─── payments/* ──── on pay
└─────────┘  final result  └──────┬───────┘
                                  │ KYA mint (auth) + PAY mint (settlement)
                                  ▼
                           ┌──────────────────────┐
                           │  Skyfire MCP issuer   │
                           │ mcp-qa.skyfire.xyz    │
                           └──────────────────────┘
```

**Two invisible flows, one issuer:**

1. **KYA (auth):** Merchant returns 401 → opencode discovers the OAuth AS →
   calls `create-kya-token` on Skyfire → exchanges the JWT assertion for an
   access token → retries the connection with `Authorization: Bearer`. The
   agent never sees the auth handshake.

2. **PAY (settlement):** Agent calls `pay` → merchant returns `isError` with
   `payments/*` signal → gateway calls `create-pay-token` on Skyfire → retries
   `pay` with the token in `_meta`. The agent only sees "Order confirmed."

**Actors:**

| Component                                                                                         | Role                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Merchant MCP server** ([`merchant.js`](merchant.js))                                            | HTTP MCP server (`:8787`) + mock OAuth AS (`:8788`). Sells products; `pay` emits the `payments/*` signal. Requires KYA auth to connect. |
| **Skyfire MCP issuer** (`mcp-qa.skyfire.xyz`)                                                     | Mints KYA tokens (auth) and PAY tokens (settlement). Its tools are hidden from the agent.                                               |
| **The gateway** (`executeWithGateway` in [`gateway.ts`](../packages/opencode/src/mcp/gateway.ts)) | Intercepts every MCP tool call, catches payment signals, resolves them autonomously, and retries.                                       |

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

> **Note on `checkout` vs `pay`:** `checkout` is a **quote** — it returns a plain order
> summary with **no** `payments/*` signal, so the gateway passes it straight through and
> mints nothing. Only `pay` emits the settlement signal, so the PAY token is minted exactly
> once, at pay time (not before the user confirms). Emitting the signal from `checkout`
> would make the gateway authorize payment during the preview — deliberately avoided.

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

[`.opencode/opencode.jsonc`](../.opencode/opencode.jsonc) wires the two servers:

```jsonc
{
  "mcp": {
    // Protected merchant — connecting triggers a 401 + KYA auth handshake.
    // Start it first: `cd merchant-mcp && npm install && npm start`.
    "merchant": {
      "type": "remote",
      "enabled": true,
      "url": "http://127.0.0.1:8787/mcp",
    },
    // Skyfire issuer — hidden from the agent. Mints KYA tokens to authenticate
    // the merchant connection and PAY tokens to settle purchases.
    "skyfire": {
      "type": "remote",
      "enabled": true,
      "url": "https://mcp-qa.skyfire.xyz/mcp",
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

> **Note on `"type": "remote"`:** In MCP config, `"type"` refers to the **transport**,
> not the network location. `"remote"` means HTTP (StreamableHTTP/SSE), `"local"` means
> spawn a child process with stdio. The merchant is an HTTP server on localhost, so it's
> `"remote"` even though it runs locally.

### 2. Set the Skyfire API key

Export your Skyfire QA API key so the `{env:SKYFIRE_API_KEY}` placeholder resolves:

```bash
export SKYFIRE_API_KEY="your-skyfire-api-key"
```

### 3. Start the merchant MCP server

The merchant is an HTTP server (`:8787`) with a built-in mock OAuth AS (`:8788`):

```bash
cd merchant-mcp
npm install
node merchant.js
```

You should see:

```
Mock MCP server listening on 127.0.0.1:8787
Mock OAuth server listening on 127.0.0.1:8788
```

### 4. Provide a real seller id and a funded wallet

- `SELLER_SERVICE_ID` in [`merchant.js`](merchant.js) must be a **real Skyfire seller
  id** (discover one via `find-sellers`). The mock merchant has no directory entry of
  its own, so it borrows a registered (sandbox) seller's identity.
- The buyer wallet behind your API key must have **balance** to mint a token — minting
  fails with `402` otherwise.

---

## Run the demo

From the repo root (so opencode picks up `.opencode/opencode.jsonc`):

```bash
cd packages/opencode
bun dev
```

In the TUI:

1. Run `/mcp` and confirm both `skyfire` and `merchant` are **connected**. Skyfire's
   tools will _not_ appear in the agent's tool list — that's intended. The merchant
   connection will have silently gone through the KYA auth handshake (401 → KYA mint →
   OAuth exchange → Bearer token → connected).
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
SKYFIRE_URL="https://mcp-qa.skyfire.xyz/mcp" SKYFIRE_API_KEY="<key>" node merchant-mcp/verify-skyfire.mjs
```

`verify-skyfire.mjs` is the fastest way to confirm the backend is reachable and the
wallet can mint **before** launching the TUI.

---

## Watching the flow live — logs

The opencode **MCP client** logs every tool call, payment signal, token mint, and gateway
retry to `~/.local/share/opencode/log/dev.log`. Open a second terminal and tail it:

```bash
tail -F ~/.local/share/opencode/log/dev.log | grep --line-buffered --color=always "service=mcp"
```

For better highlighting of specific fields (tool names, amounts, settlement types):

```bash
tail -F ~/.local/share/opencode/log/dev.log | grep --line-buffered --color=always -E "service=mcp|toolName=|settlementType=|total=|gateway:"
```

This filters to just the MCP and gateway lines.

For the **merchant server side**, watch the logs in the same terminal where the merchant is run.

You'll see JSON-RPC calls, 401 challenges, and KYA token-exchange verifications
(verified JTI, issuer, payload shape).

**Tips:**

- `--color=always` highlights the matched patterns in the output (green for matches).
- `-F` (capital) keeps following across truncations — dev mode truncates `dev.log` on each `bun dev` restart.
- Omit the grep to see all logs (other services too): `tail -F ~/.local/share/opencode/log/dev.log`.

---

## Troubleshooting

| Symptom                                                                | Cause                                                                                                        | Fix                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `merchant` shows **failed** — `KYA supported but no issuer configured` | Skyfire server is missing or doesn't declare the `org.kyapay:kya` capability.                                | Add the `capabilities` block to the skyfire config as shown above.                                             |
| `merchant` shows **failed** — `create-kya-token did not return a JWT`  | Skyfire issuer couldn't mint a KYA token (bad API key, network issue).                                       | Verify `SKYFIRE_API_KEY` is set and valid; run `verify-skyfire.mjs` to test.                                   |
| Token mint fails with **`402 … Insufficient balance`**                 | Buyer wallet has no funds for the requested amount.                                                          | Fund the wallet, or lower the order total below the balance (see [Money model](#money-model)).                 |
| **`Gateway error: … did not return a token. Issuer said: …`**          | The issuer returned an error in plain text with `isError` unset; the gateway now surfaces that real message. | Read the `Issuer said:` detail — it's the upstream reason (often balance or auth).                             |
| Agent calls `skyfire_create-pay-token` / `find-sellers` directly       | Provider-tool hiding regressed (the `providerServers` filter in `mcp/index.ts`).                             | Ensure the skyfire server still declares `capabilities`; confirm its tools are absent from `/mcp`'s tool list. |
| `skyfire` shows **failed** in `/mcp`                                   | Can't reach `mcp-qa.skyfire.xyz`, or the API key is invalid.                                                 | Check network connectivity and API key.                                                                        |
| `merchant` shows **failed** — `Connection closed`                      | Merchant HTTP server on `:8787` isn't running.                                                               | Start the merchant first: `cd merchant-mcp && node merchant.js`.                                               |

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
