# Mock MCP + KYA OAuth (Skyfire issuer + local mock OAuth + local mock MCP)

This doc describes how OpenCode authenticates to a **mock MCP server** using **KYA** where:

- **Skyfire** is used to mint the **KYA assertion** (real remote service).
- A **local mock OAuth server** exchanges that assertion for an **OAuth access token**.
- A **local mock MCP server** accepts that access token and allows MCP requests.

It also includes instructions to run the full flow locally.

---

## Overview

### Services

| Service                  | Purpose                                           | Default URL                                     |
| ------------------------ | ------------------------------------------------- | ----------------------------------------------- |
| OpenCode instance server | UI/API that manages MCP connections               | `http://localhost:4096`                         |
| Mock MCP server          | Protected MCP resource (requires Bearer token)    | `http://127.0.0.1:8787`                         |
| Mock OAuth server        | OAuth AS (discovery/registration/token endpoints) | `http://127.0.0.1:8788`                         |
| Skyfire KYA issuer       | Mints the KYA assertion used in JWT-bearer grant  | e.g. `https://api-qa.skyfire.xyz/api/v1/tokens` |

---

## What happens when you connect

When you connect an MCP server named `mock-kya`, OpenCode does (simplified):

1. **Connect attempt to the MCP endpoint**
   - `POST http://127.0.0.1:8787/mcp`
   - Mock MCP responds `401` with `WWW-Authenticate` challenge.

2. **Authorization server discovery**
   - OpenCode uses RFC 9728 protected resource discovery:
   - `GET http://127.0.0.1:8787/.well-known/oauth-protected-resource`
   - Response points to the mock OAuth server on `8788`.

3. **Dynamic client registration (if needed)**

- (Removed) This demo flow does not require Dynamic Client Registration.

4. **KYA assertion minted by Skyfire**
   - OpenCode calls Skyfire issuer endpoint to mint a KYA assertion:
   - `POST $OPENCODE_KYA_CREATE_TOKEN_URL`
   - Uses `skyfire-api-key: $OPENCODE_SKYFIRE_API_KEY`

5. **Non-interactive OAuth token exchange (JWT-bearer)**
   - OpenCode exchanges the Skyfire assertion at the mock OAuth token endpoint:
   - `POST http://127.0.0.1:8788/token`
   - Form body includes:
     - `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`
     - `assertion=<kya assertion>`

6. **Retry MCP with Bearer token**
   - OpenCode retries:
   - `POST http://127.0.0.1:8787/mcp`
   - with `Authorization: Bearer <access_token>`
   - On success, OpenCode marks `mock-kya` as **connected** and loads tool definitions.

### Key point: no browser redirect

For KYA, the flow is **non-interactive**. If something opens an `/authorize` URL, it usually means the provider is being treated as an interactive OAuth client (misconfiguration).

---

## Running locally

### 1) Install dependencies

From the repo root:

```bash
bun install
```

---

### 2) Start the mock MCP + mock OAuth servers

From the repo root:

```bash
bun run packages/opencode/script/mock-mcp-kya-server.ts
```

Expected:

- Mock MCP: `127.0.0.1:8787`
- Mock OAuth: `127.0.0.1:8788`

---

### 3) Configure OpenCode to use the mock MCP server

In the directory you’re running OpenCode against, add/update:

`.opencode/opencode.jsonc`

Example:

```jsonc
{
  "mcp": {
    "mock-kya": {
      "type": "remote",
      "url": "http://127.0.0.1:8787/mcp",

      // The mock server supports StreamableHTTP (POST /mcp). It does not implement SSE.
      "transport": "streamable_http",

      "oauth": {
        "kya": {
          "tokenType": "kya",
          "buyerTag": "test",
          "tokenAmount": 1,

          // Must be a UUID accepted by Skyfire for your environment.
          "sellerServiceId": "00000000-0000-0000-0000-000000000000",

          // Optional:
          // "apiKey": "..."     // prefer env vars for secrets
          // "expiresAt": 123456 // unix seconds
        },
      },
    },
  },
}
```

Notes:

- `transport: "streamable_http"` is important to avoid SSE fallback errors.
- `sellerServiceId` must be a valid UUID and must be valid for the Skyfire environment you’re calling.

---

### 4) Export Skyfire env vars

In the terminal where you’ll run OpenCode:

```bash
export OPENCODE_KYA_CREATE_TOKEN_URL="https://api-qa.skyfire.xyz/api/v1/tokens"
export OPENCODE_SKYFIRE_API_KEY="<your skyfire api key>"
```

Security note: do **not** commit API keys into the repo.

---

### 5) Start OpenCode instance server

From `packages/opencode`:

```bash
cd packages/opencode
bun dev serve --port 4096 --log-level DEBUG --print-logs
```

---

### 6) Connect via the web UI or via API

#### Web UI

Open the UI you use that points at `http://localhost:4096`, then connect the `mock-kya` MCP server.

#### HTTP API

Replace the directory with your actual project directory (URL-encoded):

```bash
curl -sS -X POST \
  'http://localhost:4096/mcp/mock-kya/connect?directory=%2FUsers%2Fjamesschuler%2Fdev%2Fopencode' | jq
```

Check status:

```bash
curl -sS \
  'http://localhost:4096/mcp?directory=%2FUsers%2Fjamesschuler%2Fdev%2Fopencode' | jq
```

You should see `mock-kya` become `connected`.

---

## How to verify the KYA assertion is exchanged for an OAuth token

### 1) OpenCode logs (port 4096)

With `--log-level DEBUG --print-logs`, OpenCode prints non-sensitive debug logs during the flow, including:

- `requestKyaAssertion: requesting kya assertion` (Skyfire call)
- `requestKyaAssertion: received kya assertion` (prints assertion prefix only)
- `exchangeKyaForAccessToken: exchanging kya assertion for oauth token` (POST to `http://127.0.0.1:8788/token`)
- `exchangeKyaForAccessToken: oauth token exchange succeeded` (prints access token prefix only)
- `saved oauth tokens`

These are emitted from `packages/opencode/src/mcp/oauth-provider.ts`.

### 2) Mock OAuth server logs (port 8788)

The mock OAuth server logs when it issues an access token (prints only a prefix).

---

## Running with verbose logging

This section includes copy/paste commands to run all components with logs enabled.

### 1) Start the mock MCP + mock OAuth servers (with request logging)

From the repo root:

```bash
bun run packages/opencode/script/mock-mcp-kya-server.ts
```

Look for logs like:

- `authServer: request` (every request)
- `authServer: token(jwt-bearer) request`
- `verifyKyaAssertion: verified`
- `authServer: token issued`
- `mcpServer: request` (every request)
- `mcpServer: unauthorized`
- `mcpServer: authorized`
- `mcpServer: initialize`
- `mcpServer: tools/list`

### 2) Start OpenCode server with logs

From the repo root:

```bash
cd packages/opencode
OPENCODE_KYA_CREATE_TOKEN_URL="https://api-qa.skyfire.xyz/api/v1/tokens" \
OPENCODE_SKYFIRE_API_KEY="<your skyfire api key>" \
bun dev serve --port 4096 --log-level DEBUG --print-logs
```

Look for logs like:

- `service=mcp connecting`
- `service=mcp transport connect attempt`
- `service=mcp.oauth requesting kya assertion`
- `service=mcp.oauth exchanging kya assertion for oauth token`
- `service=mcp.oauth oauth token exchange succeeded`
- `service=mcp.oauth saved oauth tokens`

---

## Troubleshooting

### `SSE error: Non-200 status code (404)`

Cause: client attempted SSE transport against the mock MCP server.

Fix: ensure the MCP config includes:

```jsonc
"transport": "streamable_http"
```

Restart OpenCode.

---

### `KYA issuer request failed (401): Invalid API Key`

Cause: wrong/missing Skyfire API key or wrong issuer URL.

Fix:

- confirm `OPENCODE_SKYFIRE_API_KEY` is set in the same shell where OpenCode runs
- confirm `OPENCODE_KYA_CREATE_TOKEN_URL` matches the environment for your key

---

### `KYA issuer request failed (422): Validation Error`

Cause: Skyfire rejected some request fields (commonly `sellerServiceId` not a UUID or not valid for that env).

Fix:

- set a valid UUID `sellerServiceId`
- ensure it’s valid for the Skyfire environment you’re calling

---
