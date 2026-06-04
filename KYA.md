# Mock MCP + KYA OAuth (Skyfire issuer + local mock OAuth + local mock MCP)

This doc describes how OpenCode authenticates to a **mock MCP server** using a **KYA-style flow** where:

- **Skyfire MCP** is used as the **token issuer** (via MCP tool call).
- A **local mock MCP server** requires an access token.

OpenCode does **not** call Skyfire's REST APIs directly.

It also includes instructions to run the full flow locally.

---

## Overview

### Services

| Service                  | Purpose                                           | Default URL                  |
| ------------------------ | ------------------------------------------------- | ---------------------------- |
| OpenCode instance server | UI/API that manages MCP connections               | `http://localhost:4096`      |
| Mock MCP server          | Protected MCP resource (requires Bearer token)    | `http://127.0.0.1:8787`      |
| Mock OAuth server        | OAuth AS (discovery/registration/token endpoints) | `http://127.0.0.1:8788`      |
| Skyfire MCP issuer       | Mints a KYA JWT assertion via `create-kya-token`  | `http://mcp.skyfire.xyz/mcp` |

---

## What happens when you connect

When you connect an MCP server named `mock-kya-mcp`, OpenCode does (simplified):

1. **Connect attempt to the MCP endpoint**
   - `POST http://127.0.0.1:8787/mcp`
   - Mock MCP responds `401` with `WWW-Authenticate` challenge.

2. **Authorization server discovery**
   - OpenCode uses RFC 9728 protected resource discovery:
   - `GET http://127.0.0.1:8787/.well-known/oauth-protected-resource`
   - Response points to the mock OAuth server on `8788`.

3. **Dynamic client registration (if needed)**

- (Removed) This demo flow does not require Dynamic Client Registration.

4. **KYA assertion minted by Skyfire MCP issuer**

- OpenCode connects to the MCP server named `skyfire` and calls:
- `tools/call { name: "create-kya-token", arguments: { sellerServiceId: "…" } }`
- Skyfire returns a **KYA JWT assertion** (not an OAuth access token).

5. **Exchange assertion for an OAuth access token (JWT-bearer)**

- OpenCode POSTs to the mock OAuth token endpoint (`http://127.0.0.1:8788/token`) with:
  - `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`
  - `assertion=<kya_jwt>`
- Mock OAuth returns `{ access_token, token_type, ... }`.

6. **Retry MCP with Bearer access token**
   - OpenCode retries:
   - `POST http://127.0.0.1:8787/mcp`
   - with `Authorization: Bearer <access_token>`

- On success, OpenCode marks `mock-kya-mcp` as **connected** and loads tool definitions.

### Key point: no browser redirect

For KYA, the flow is **non-interactive** (no user browser step). If something opens an `/authorize` URL, it usually means KYA detection or the jwt-bearer exchange failed.

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
    "mock-kya-mcp": {
      "type": "remote",
      "url": "http://127.0.0.1:8787/mcp",
    },

    "skyfire": {
      "type": "remote",
      "url": "http://mcp.skyfire.xyz/mcp",
      "headers": {
        "skyfire-api-key": "<your-skyfire-api-key>",
      },
    },
  },
}
```

Notes:

- OpenCode will prefer StreamableHTTP; SSE 404 is treated as unsupported.
- Set your Skyfire API key via the `skyfire` MCP server's `headers.skyfire-api-key`.

### 4) Export KYA env vars

The Skyfire QA issuer tool requires `sellerServiceId`:

```bash
export OPENCODE_KYA_SELLER_SERVICE_ID="662a28ea-fbd7-4bd3-9f05-3d3e6ea14d03"
# Optional
export OPENCODE_KYA_BUYER_TAG="your-buyer-tag"
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

Open the UI you use that points at `http://localhost:4096`, then connect the `mock-kya-mcp` MCP server.

#### HTTP API

Replace the directory with your actual project directory (URL-encoded):

```bash
curl -sS -X POST \
  'http://localhost:4096/mcp/mock-kya-mcp/connect?directory=%2FUsers%2Fjamesschuler%2Fdev%2Fopencode' | jq
```

Check status:

```bash
curl -sS \
  'http://localhost:4096/mcp?directory=%2FUsers%2Fjamesschuler%2Fdev%2Fopencode' | jq
```

You should see `mock-kya-mcp` become `connected`.

---

## How to verify the token mint + MCP auth works

### 1) OpenCode logs (port 4096)

With `--log-level DEBUG --print-logs`, OpenCode prints non-sensitive debug logs during the flow, including:

- `service=mcp transport connect attempt`
- `kya mint: calling skyfire create-kya-token`
- `kya mint: skyfire tool response`
- `kya mint: stored token, retrying StreamableHTTP connect`

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
bun dev serve --port 4096 --log-level DEBUG --print-logs
```

Look for logs like:

- `service=mcp connecting`
- `service=mcp transport connect attempt`
- `service=mcp.oauth saved oauth tokens`

---

## Troubleshooting

### `SSE error: Non-200 status code (404)`

Cause: client attempted SSE transport against the mock MCP server.

Status: OpenCode treats SSE 404 as "unsupported" for MCP servers, so this should no longer block StreamableHTTP connections.

---

### `create-kya-token did not return a JWT`

Cause: the Skyfire MCP issuer did not return a string containing a JWT assertion.

Fix:

- confirm `mcp.skyfire` is configured and reachable
- confirm `mcp.skyfire.headers.skyfire-api-key` is set

### `kya mint skipped: missing OPENCODE_KYA_SELLER_SERVICE_ID`

Cause: Skyfire QA requires the `sellerServiceId` argument.

Fix: export `OPENCODE_KYA_SELLER_SERVICE_ID` before starting OpenCode.

---
