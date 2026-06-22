# Mock MCP + KYA OAuth (Skyfire issuer + local mock OAuth + local mock MCP)

This doc describes how OpenCode authenticates to a **mock MCP server** using a **KYA-style flow** where:

- **Skyfire MCP** is used as the **token issuer** (via MCP tool call).
- A **local mock MCP server** requires an access token.

OpenCode does **not** call Skyfire's REST APIs directly.

It also includes instructions to run the full flow locally — via the **CLI**, the
**web app**, and the **desktop app**.

> This is the hands-on runbook. For the design/architecture reference (data
> structures, decision matrix, code-path walkthrough, security model), see
> [KYA-TECH-SPEC.md](KYA-TECH-SPEC.md).

---

## Overview

### Services

| Service                  | Purpose                                           | Default URL                  |
| ------------------------ | ------------------------------------------------- | ---------------------------- |
| OpenCode instance server | UI/API that manages MCP connections               | `http://localhost:4096`      |
| Mock MCP server          | Protected MCP resource (requires Bearer token)    | `http://127.0.0.1:8787`      |
| Mock OAuth server        | OAuth AS (discovery/registration/token endpoints) | `http://127.0.0.1:8788`      |
| Skyfire MCP issuer       | Mints a KYA JWT assertion via configured KYA tool | `http://mcp.skyfire.xyz/mcp` |

---

## What happens when you connect

When you connect an MCP server named `merchant-mcp`, OpenCode does (simplified):

1. **Unauthenticated probe (spec B1–B2)**
   - `POST http://127.0.0.1:8787/mcp` with no `Authorization` header.
   - Mock MCP responds `401` with a `WWW-Authenticate` challenge that may carry a
     `resource_metadata="…"` pointer (RFC 9728).

2. **Authorization server discovery (B3–B5)**
   - OpenCode follows the `resource_metadata` pointer when present, otherwise
     falls back to the default RFC 9728 location:
   - `GET http://127.0.0.1:8787/.well-known/oauth-protected-resource`
   - Response points to the mock OAuth server on `8788`. OpenCode then reads the
     AS metadata (RFC 8414, with OpenID configuration as a fallback) and checks
     that `authorization_grant_profiles_supported` advertises the KYA profile
     (`urn:ietf:params:oauth:grant-profile:kya`). If it doesn't, KYA is skipped.

3. **Consent gate (Sign in with Skyfire KYA)**

- If KYA is advertised, the first connect does **not** mint. OpenCode stops at
  status `needs_kya_consent` and asks you to approve using your Skyfire KYA
  identity for this server. Approving reconnects with `kyaConsent=true`, which is
  what triggers the mint. (No Dynamic Client Registration is used in this flow.)

4. **KYA assertion minted by the Skyfire MCP issuer**

- The KYA issuer must be **enabled** (toggled on, hence connected) first —
  connecting it validates its config and `skyfire-api-key`. If it isn't, the
  connect fails asking you to enable it. This matches payments, which mint only
  through a connected issuer.
- OpenCode connects to the configured **KYA issuer** — the remote MCP server
  whose `capabilities` map includes `org.kyapay:kya` (the server's name is irrelevant;
  the example below uses `skyfire`) — and calls the configured tool, e.g.
  `tools/call { name: "create-kya-token", arguments: <seller-selector> }`.
- The seller selector is one of (highest precedence first):
  - `{ sellerServiceId: "<UUID>" }` — from `OPENCODE_KYA_SELLER_SERVICE_ID` when exported.
  - `{ sellerServiceId: "<UUID>" }` — from a `seller_service_id` advertised by the
    target's protected-resource metadata, when present.
  - `{ sellerDomainOrUrl: "<host>" }` — otherwise, derived from the target MCP server URL.
    For a localhost/private target the host is substituted with `mcp-server.com`.
- Skyfire returns a **KYA JWT assertion** (not an OAuth access token).

5. **Exchange assertion for an OAuth access token (JWT-bearer)**

- OpenCode POSTs (`application/x-www-form-urlencoded`) to the mock OAuth token
  endpoint (`http://127.0.0.1:8788/token`) with **only** these two fields:
  - `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`
  - `assertion=<kya_jwt>`
- The exchange sends **no** `client_id`/`client_secret`, no `Authorization`
  header, and **no `scope`** — all trust comes from the issuer-signed assertion,
  which the AS validates (signature via JWKS, `iss`, `exp`, and `jti` replay).
- Mock OAuth returns `{ access_token, token_type, expires_in, scope }`. OpenCode
  keeps **only `access_token`** for the silent path — `expires_in`, `scope`, and
  any `refresh_token` are discarded (see "Token lifetime" below).

6. **Retry MCP with Bearer access token**
   - OpenCode retries:
   - `POST http://127.0.0.1:8787/mcp`
   - with `Authorization: Bearer <access_token>`

- On success, OpenCode marks `merchant-mcp` as **connected** and loads tool definitions.

### Key point: no browser redirect

KYA needs one in-app confirmation (the consent gate above), but **no browser
redirect** — the mint and token exchange are non-interactive. If something opens
an `/authorize` URL, it usually means KYA detection or the jwt-bearer exchange
failed and OpenCode fell back to interactive OAuth.

By default, if the server **advertises KYA** but no issuer is configured (or
minting fails), OpenCode surfaces a clear failure rather than falling back to
interactive OAuth. Set `OPENCODE_KYA_INTERACTIVE_FALLBACK=1` to fall through to
the standard interactive Authorization Code + PKCE flow in that case.

If the server does **not** advertise KYA, OpenCode always falls back to the
interactive flow regardless of that flag (KYA is purely an opt-in optimization
keyed on the AS metadata, per spec §5.5).

### Token lifetime (no local expiry, no refresh)

Because the silent path stores only the access token (no `expiresAt`), a
KYA-minted token shows as **`authenticated` indefinitely** in `opencode mcp list`
/ the UI — OpenCode does **not** re-mint on a timer. A fresh mint happens only
when the MCP server **rejects the stale token with a 401**, which re-enters the
connect flow. There is no refresh-token path for KYA; "refresh" is always a full
re-mint via the issuer. To force a clean re-mint, clear stored auth:

```sh
rm ~/.local/share/opencode/mcp-auth.json
```

> The exchange is implemented twice: inline in the silent connect path and as a
> standalone helper used by `opencode mcp debug` (see
> [KYA-TECH-SPEC.md](KYA-TECH-SPEC.md) §7.5). They share no code — keep both in
> sync if you change the exchange contract.

---

## Sequence diagram

The full connect flow — issuer self-skip, the consent gate, the issuer-enabled
check, the B→C→D mint, and the interactive fallback — is in the technical spec:
[KYA-TECH-SPEC.md](KYA-TECH-SPEC.md) §16. It lives there as a single Mermaid
diagram so the two docs can't drift apart.

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

### One-command local demo

From the repo root, this starts both the mock MCP/OAuth server and the
OpenCode instance server:

```bash
bun run demo:kya
```

This does not edit or validate `.opencode/opencode.jsonc`; keep your Skyfire
MCP issuer configuration and API key there.

---

### 3) Configure OpenCode to use the mock MCP server

In the directory you’re running OpenCode against, add/update:

`.opencode/opencode.jsonc`

Example:

```jsonc
{
  "mcp": {
    "merchant-mcp": {
      "type": "remote",
      "url": "http://127.0.0.1:8787/mcp",
    },

    "skyfire": {
      "type": "remote",
      "url": "http://mcp.skyfire.xyz/mcp",
      "capabilities": {
        "org.kyapay:kya": {
          "tool": "create-kya-token",
        },
      },
      "headers": {
        "skyfire-api-key": "<your-skyfire-api-key>",
      },
    },
  },
}
```

Notes:

- OpenCode will prefer StreamableHTTP; SSE 404 is treated as unsupported.
- Set your Skyfire API key via the issuer MCP server's `headers.skyfire-api-key`.
- The KYA issuer is selected by **capability**, not by name: OpenCode uses the
  first remote MCP server whose `capabilities` map contains `org.kyapay:kya`.
  The nested `tool` value tells OpenCode which issuer MCP tool creates the KYA token.
  Omitting that entry means no issuer is found and KYA minting is skipped.

### 4) Seller target selection

The Skyfire `create-kya-token` MCP tool needs exactly one seller selector
(see [Skyfire create-token docs](https://docs.skyfire.xyz/reference/create-token)).
OpenCode resolves it with the following precedence:

1. **`sellerServiceId` (env override)** — explicit override via environment
   variable. If set, OpenCode passes it directly to the tool:

   ```bash
   export OPENCODE_KYA_SELLER_SERVICE_ID="662a28ea-fbd7-4bd3-9f05-3d3e6ea14d03"
   ```

2. **`sellerServiceId` (advertised)** — if the env var is unset but the target's
   protected-resource metadata advertises a `seller_service_id`, OpenCode uses
   that. This lets a resource bind itself to the right Skyfire seller without an
   env override.

3. **`sellerDomainOrUrl`** — derived from the **target MCP server's URL** when
   neither of the above applies:
   - For a public MCP server like `https://mcp.example.com/mcp`, the seller is
     `mcp.example.com`.
   - For a localhost/loopback target (e.g. the mock at
     `http://127.0.0.1:8787/mcp`), the hostname can't be resolved by the
     Skyfire seller directory, so OpenCode substitutes a stable placeholder:
     **`mcp-server.com`**.

No environment variable is required by default; export
`OPENCODE_KYA_SELLER_SERVICE_ID` only when you want to bind to a specific
Skyfire seller service.

Security note: do **not** commit API keys into the repo.

---

### 5) Start OpenCode instance server

Needed for the **CLI** and **web app** frontends. The **desktop app** spawns its
own embedded server, so desktop-only users can skip this step (see step 6).

From `packages/opencode`:

```bash
cd packages/opencode
bun dev serve --port 4096 --log-level DEBUG --print-logs
```

---

### 6) Connect via a frontend

You can drive the connect/auth flow from any of three frontends. All of them
ultimately issue the same `POST /mcp/<name>/connect` against an instance server
and run the same KYA detection + consent gate — they differ only in how the
instance server is provided and where the interactive browser step (if any) lands.

| Frontend | Instance server | Best for |
| --- | --- | --- |
| **CLI** (`opencode mcp …`) | the one you started in step 5 | scripting, full DEBUG logs, the interactive `mcp auth` flow |
| **Web app** (`packages/app`) | a **separate** server you run (step 5 / `demo:kya`) | browser UI during local dev |
| **Desktop app** (`packages/desktop`) | an **embedded** server it spawns itself (sidecar) | a one-process, app-like experience |

#### Web app

The web frontend (`packages/app`, a SolidJS + Vite app) runs separately from the
instance server and talks to it over HTTP.

1. Keep the instance server from step 5 running on port `4096`.
2. In a second terminal, from the repo root, start the frontend dev server:

   ```bash
   bun run dev:web
   # equivalently: bun --cwd packages/app dev
   ```

   It serves on **`http://localhost:3000`**.

3. By default the frontend connects to the instance server at
   `http://localhost:4096` (via `VITE_OPENCODE_SERVER_HOST`/`VITE_OPENCODE_SERVER_PORT`,
   see [packages/app/src/entry.tsx](../packages/app/src/entry.tsx#L105)). If your
   server runs elsewhere, override it before starting Vite:

   ```bash
   VITE_OPENCODE_SERVER_HOST=localhost VITE_OPENCODE_SERVER_PORT=4096 bun run dev:web
   ```

4. Open `http://localhost:3000`, select the project directory you started the
   server against, and open the MCP dialog. **Enable the `skyfire` issuer first**
   (toggle it on, which validates its API key), then connect `merchant-mcp`. The
   first connect to a KYA server shows the **"Sign in with Skyfire KYA"** consent
   dialog (status `needs_kya_consent`); approving reconnects with `kyaConsent=true`
   and mints the token.

A server showing `needs_auth` (KYA not advertised, or the interactive fallback)
instead calls `mcp.auth.authenticate` when clicked, which drives the
**interactive** OAuth flow — it opens the browser on the **server** host and waits
for the loopback callback.

> Note: the silent KYA flow is fully non-interactive, so it works even when the
> frontend is remote. The interactive flow, however, opens the browser on the
> server host and redirects to a loopback callback there (`http://127.0.0.1:19876/...`),
> so it only completes when the browser and instance server share a machine (i.e.
> local dev) unless a custom `oauth.redirectUri` is configured. For a truly remote
> web app the split `mcp.auth.start` → open-in-user-browser → `mcp.auth.callback`
> flow (with an app-hosted redirect) would be required.

#### Desktop app

The desktop frontend (`packages/desktop`) is an **Electron** app. Unlike the web
app, it does **not** need a separately-started instance server — by default it
**spawns its own embedded OpenCode server** as a sidecar
([packages/desktop/src/main/server.ts](../packages/desktop/src/main/server.ts)),
so the server and the browser surface always share the same machine. That means
**both** the silent KYA flow and the interactive loopback callback work out of
the box.

1. Keep the mock MCP + OAuth servers from step 2 running (the desktop app
   provides the *instance* server, but not the mock *resource*/*AS*).
2. Make sure your project's `.opencode/opencode.jsonc` is configured as in step 3.
3. From the repo root, start the desktop app:

   ```bash
   bun run dev:desktop
   # equivalently: bun --cwd packages/desktop dev
   ```

   The `predev` step builds the embedded Node server
   ([packages/desktop/scripts/predev.ts](../packages/desktop/scripts/predev.ts)),
   then `electron-vite dev` launches the app window.

4. In the app, open the project directory you configured and open the MCP dialog.
   As in the web app, **enable the `skyfire` issuer first**, then connect
   `merchant-mcp` — the first connect to a KYA server shows the "Sign in with
   Skyfire KYA" consent dialog (`needs_kya_consent`), and approving mints the
   token. A `needs_auth` server instead runs `mcp.auth.authenticate`.

> **Pointing the desktop app at an external server (optional).** If you want the
> desktop UI but also the verbose `--print-logs` output from a server you control,
> run the `demo:kya` server (or step 5's server) and set the desktop app's default
> server URL to `http://localhost:4096` from within the app's settings (stored via
> `setDefaultServerUrl`). When a default server URL is set, the app uses it instead
> of spawning the embedded sidecar.

#### HTTP API

Replace the directory with your actual project directory (URL-encoded):

```bash
curl -sS -X POST \
  'http://localhost:4096/mcp/merchant-mcp/connect?directory=%2FUsers%2Fjamesschuler%2Fdev%2Fopencode' | jq
```

Check status:

```bash
curl -sS \
  'http://localhost:4096/mcp?directory=%2FUsers%2Fjamesschuler%2Fdev%2Fopencode' | jq
```

You should see `merchant-mcp` become `connected`.

---

## Testing the interactive OAuth fallback

KYA is an optimization layered on top of standard OAuth. To exercise the
interactive Authorization Code + PKCE fallback locally, run the mock with KYA
disabled so the AS behaves like a vanilla OAuth server.

1. Start the mock servers with `MOCK_DISABLE_KYA=1`:

   ```bash
   MOCK_DISABLE_KYA=1 bun run packages/opencode/script/mock-mcp-kya-server.ts
   ```

   The AS now omits `kya` from `authorization_grant_profiles_supported` and
   serves an auto-approving `/authorize` endpoint plus an `authorization_code`
   token grant (PKCE `S256` enforced). The startup banner shows
   `Mode: interactive (KYA disabled)`.

2. Configure only the protected server — no KYA issuer is needed:

   ```jsonc
   { "mcp": { "merchant-mcp": { "type": "remote", "url": "http://127.0.0.1:8787/mcp" } } }
   ```

3. Start the OpenCode server normally — **no flag needed**. Because the mock no
   longer advertises KYA, an auth-required connect falls back to interactive
   automatically:

   ```bash
   bun dev serve --port 4096 --log-level DEBUG --print-logs
   ```

4. Trigger auth, either way:
   - **Automatic fallback:** connect the server (web UI, or
     `POST /mcp/merchant-mcp/connect`). Since KYA isn't advertised, the status
     becomes `needs_auth` with no flag required. Then complete it with
     `opencode mcp auth merchant-mcp`.
   - **Direct:** `opencode mcp auth merchant-mcp` runs the interactive flow
     regardless of connect state.

   > `OPENCODE_KYA_INTERACTIVE_FALLBACK=1` is only needed for the **other** branch:
   > when a server **does** advertise KYA but no issuer is configured (run the mock
   > _without_ `MOCK_DISABLE_KYA`). There the default is a hard failure, and the flag
   > makes it fall through to interactive instead.

   `opencode mcp auth` opens the browser at the mock `/authorize`, which
   auto-approves and redirects to the loopback callback
   (`http://127.0.0.1:19876/mcp/oauth/callback`); OpenCode exchanges the code at
   `/token` and stores the resulting access token.

In the mock logs you'll see the interactive markers:
`===== OAuth interactive flow BEGIN (authorization_code) =====` → `[authServer] authorize -> redirect`
→ `===== OAuth token exchange BEGIN (authorization_code) =====` → `===== OAuth token exchange END (access token issued) =====`
→ `===== OAuth interactive flow END (authorization_code) =====`.

> Because the callback is a server-host loopback (`127.0.0.1:19876`), run the
> browser on the same machine as the OpenCode server, or set a custom
> `oauth.redirectUri` on the MCP server config.

## Testing Regular OAuth Flow

Add an OAuth MCP server like Context7 to `opencode.jsonc`:

```jsonc
"context7": {
  "type": "remote",
  "enabled": true,
  "url": "https://mcp.context7.com/mcp/oauth",
},
```

Toggle it on to confirm OAuth is working.

To clear stored OAuth connections and test a fresh flow:

```sh
rm ~/.local/share/opencode/mcp-auth.json
```

---

## How to verify the token mint + MCP auth works

### 1) OpenCode logs (port 4096)

With `--log-level DEBUG --print-logs`, OpenCode prints non-sensitive debug logs
during the flow. Each line is tagged with its emitting function, e.g.:

- `===== KYA auth flow BEGIN =====` / `===== KYA auth flow END =====` (flow boundaries)
- `[connectRemote] transport connect attempt`
- `[trySilentKya] fetching protected resource metadata`
- `[trySilentKya] AS grant profiles`
- `[trySilentKya] calling issuer KYA tool`
- `[trySilentKya] skyfire tool response`
- `[trySilentKya] extracted assertion`
- `[trySilentKya] exchanging assertion for access token`
- `[trySilentKya] token exchange success`
- `[trySilentKya] stored access token`
- `[connectRemote] kya mint: stored token, retrying StreamableHTTP connect`

Tip: `--print-logs 2>&1 | grep --line-buffered -E "=====|\[trySilentKya\]"` surfaces
just the KYA flow.

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

- `[authServer] request` (every request)
- `[authServer] token(jwt-bearer) request`
- `[verifyKyaAssertion] verified`
- `[authServer] token issued`
- `[mcpServer] request` (every request)
- `[mcpServer] unauthorized`
- `[mcpServer] authorized`
- `[mcpServer] initialize`
- `[mcpServer] tools/list`
- `===== MCP auth flow BEGIN / END =====` and `===== OAuth token exchange BEGIN / END =====` (flow boundaries)

### 2) Start OpenCode server with logs

From the repo root:

```bash
cd packages/opencode
bun dev serve --port 4096 --log-level DEBUG --print-logs
```

Look for logs like:

- `service=mcp … [connectRemote] connecting`
- `service=mcp … [connectRemote] transport connect attempt`
- `service=mcp.oauth … [saveTokens] saved oauth tokens`

---

## Troubleshooting

### `SSE error: Non-200 status code (404)`

Cause: client attempted SSE transport against the mock MCP server.

Status: OpenCode treats SSE 404 as "unsupported" for MCP servers, so this should no longer block StreamableHTTP connections.

---

### `Could not extract JWT assertion from skyfire tool output` / `create-kya-token did not return a JWT assertion`

Cause: the Skyfire MCP issuer did not return a string containing a JWT assertion.

Fix:

- confirm the KYA issuer (the remote MCP server with `capabilities["org.kyapay:kya"].tool`) is configured and reachable
- confirm its `headers.skyfire-api-key` is set

### `create-kya-token` returns a "seller not found" / 4xx error

Cause: the seller selector OpenCode sent to Skyfire isn't registered in the
seller directory for the API key's environment.

Fix (pick one):

- Export `OPENCODE_KYA_SELLER_SERVICE_ID=<uuid>` to pin a known seller service
  by UUID (takes precedence over the URL-derived path).
- Public MCP server: confirm the server's domain is registered as a seller in
  the Skyfire environment matching your API key.
- Localhost MCP server: confirm the placeholder `mcp-server.com` is registered
  as a seller in the Skyfire QA environment, or set
  `OPENCODE_KYA_SELLER_SERVICE_ID` to bypass the URL-derived path.

---
