# KYA + OAuth + MCP — Operations Guide

How an autonomous agent authenticates to a protected MCP server using a
**KYA-style flow**, where:

- A **KYA issuer** (Skyfire's MCP server in the reference deployment) mints a
  signed KYA assertion via an MCP tool call.
- A **protected MCP server** requires an OAuth access token.
- The agent exchanges the assertion for that access token and connects.

The agent does **not** call the issuer's REST APIs directly — minting always goes
through an MCP tool call on the issuer.

> This is the operations guide. For the design/architecture reference (data
> structures, decision matrix, flow walkthrough, security model), see
> [KYA-TECH-SPEC.md](KYA-TECH-SPEC.md).

---

## Overview

### Roles

| Role                | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| Agent               | The MCP client that manages connections and auth.    |
| Protected MCP server| The MCP resource that requires a Bearer token.       |
| OAuth AS            | The resource's Authorization Server (discovery/registration/token endpoints). |
| KYA issuer          | Mints a KYA JWT assertion via a configured MCP tool. |

---

## What happens when you connect

When you connect a protected MCP server, the agent does (simplified):

1. **Unauthenticated probe (spec B1–B2)**
   - `POST <server>/mcp` with no `Authorization` header.
   - The server responds `401` with a `WWW-Authenticate` challenge that may carry a
     `resource_metadata="…"` pointer (RFC 9728).

2. **Authorization server discovery (B3–B5)**
   - The agent follows the `resource_metadata` pointer when present, otherwise falls
     back to the default RFC 9728 location
     (`<server>/.well-known/oauth-protected-resource`).
   - That response points to the OAuth AS. The agent reads the AS metadata (RFC
     8414, with OpenID configuration as a fallback) and checks that
     `authorization_grant_profiles_supported` advertises the KYA profile
     (`urn:ietf:params:oauth:grant-profile:kya`). If it doesn't, KYA is skipped.

3. **Consent gate (Sign in with KYA)**
   - If KYA is advertised, the first connect does **not** mint. The agent stops at
     status `needs_kya_consent` and asks you to approve using your KYA identity for
     this server. Approving reconnects with consent, which is what triggers the mint.
     (No Dynamic Client Registration is used in this flow.)

4. **KYA assertion minted by the issuer**
   - The KYA issuer must be **enabled** (connected) first — connecting it validates
     its config and API key. If it isn't, the connect fails asking you to enable it.
     This matches payments, which mint only through a connected issuer.
   - The agent connects to the configured **KYA issuer** — the remote MCP server
     whose `capabilities` map includes `org.kyapay:kya` (the name is irrelevant; the
     example below uses `skyfire`) — and calls the configured tool, e.g.
     `tools/call { name: "create-kya-token", arguments: <seller-selector> }`.
   - The seller selector is one of (highest precedence first):
     - `{ sellerServiceId: "<UUID>" }` from an explicit override.
     - `{ sellerServiceId: "<UUID>" }` from a `seller_service_id` advertised by the
       target's protected-resource metadata.
     - `{ sellerDomainOrUrl: "<host>" }` otherwise, derived from the target URL. For
       a localhost/private target the host is substituted with a placeholder domain.
   - The issuer returns a **KYA JWT assertion** (not an OAuth access token).

5. **Exchange assertion for an OAuth access token (jwt-bearer)**
   - The agent POSTs (`application/x-www-form-urlencoded`) to the AS token endpoint
     with **only** two fields:
     - `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`
     - `assertion=<kya_jwt>`
   - The exchange sends **no** `client_id`/`client_secret`, no `Authorization`
     header, and **no `scope`** — all trust comes from the issuer-signed assertion,
     which the AS validates (signature via JWKS, `iss`, `exp`, `jti` replay).
   - The AS returns `{ access_token, token_type, expires_in, scope }`. The agent
     keeps **only `access_token`** — `expires_in`, `scope`, and any `refresh_token`
     are discarded (see "Token lifetime").

6. **Retry MCP with the Bearer access token**
   - The agent retries `POST <server>/mcp` with `Authorization: Bearer <access_token>`.
   - On success, the server is marked **connected** and tool definitions are loaded.

### Key point: no browser redirect

KYA needs one in-app confirmation (the consent gate above), but **no browser
redirect** — the mint and token exchange are non-interactive. If something opens an
`/authorize` URL, it usually means KYA detection or the jwt-bearer exchange failed
and the agent fell back to interactive OAuth.

By default, if the server **advertises KYA** but no issuer is configured (or minting
fails), the agent surfaces a clear failure rather than falling back to interactive
OAuth. An interactive-fallback toggle can flip that case to the standard interactive
Authorization Code + PKCE flow.

If the server does **not** advertise KYA, the agent always falls back to the
interactive flow regardless of that toggle (KYA is purely an opt-in optimization
keyed on the AS metadata).

### Token lifetime (no local expiry, no refresh)

Because the silent path stores only the access token (no expiry), a KYA-minted token
shows as **authenticated indefinitely** — the agent does **not** re-mint on a timer.
A fresh mint happens only when the MCP server **rejects the stale token with a 401**,
which re-enters the connect flow. There is no refresh-token path for KYA; "refresh"
is always a full re-mint via the issuer. To force a clean re-mint, clear the agent's
stored MCP auth.

---

## Configuration

Configure the protected server and the KYA issuer in your agent's MCP config:

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
      },
      "headers": {
        "skyfire-api-key": "{env:SKYFIRE_API_KEY}",
      },
    },
  },
}
```

Notes:

- The agent prefers StreamableHTTP; an SSE 404 is treated as unsupported.
- Supply the issuer API key via the issuer server's `headers`, using environment
  interpolation. **Do not commit API keys.**
- The KYA issuer is selected by **capability**, not by name: the agent uses the first
  remote server whose `capabilities` map contains `org.kyapay:kya`. The nested `tool`
  value names the issuer tool that mints the assertion. Omitting it means no issuer
  is found and KYA minting is skipped.

### Seller target selection

The `create-kya-token` tool needs exactly one seller selector. The agent resolves it
with this precedence:

1. **Explicit `sellerServiceId` override** — passed directly to the tool when set.
2. **Advertised `sellerServiceId`** — if the target's protected-resource metadata
   advertises a `seller_service_id`, the agent uses it.
3. **`sellerDomainOrUrl`** — derived from the target URL when neither applies:
   - For a public server like `https://mcp.example.com/mcp`, the seller is
     `mcp.example.com`.
   - For a localhost/loopback target, the hostname can't be resolved by the issuer's
     seller directory, so the agent substitutes a stable placeholder domain.

---

## Running locally

1. **Start a protected MCP server and its OAuth AS.** Use a reference harness that
   serves the protected `/mcp` endpoint plus the AS discovery/registration/token
   endpoints (see [KYA-TECH-SPEC.md](KYA-TECH-SPEC.md) §15). The AS should advertise
   the KYA grant profile and verify real issuer-signed assertions against the
   issuer's JWKS.
2. **Configure the agent** with the protected server and the KYA issuer (above).
3. **Enable the issuer first** (toggle it on / connect it) so its API key is
   validated, then connect the protected server.
4. The first connect to a KYA server shows the **Sign in with KYA** consent prompt
   (status `needs_kya_consent`); approving reconnects with consent and mints the
   token.

### Driving the connect/auth flow

Any client surface ultimately issues the same connect operation against the agent
and runs the same KYA detection + consent gate. A connect call on a KYA server first
returns `needs_kya_consent`; a second call carrying the consent flag approves the
sign-in and mints. A status call reports when the server becomes `connected`.

A server showing `needs_auth` (KYA not advertised, or the interactive fallback)
instead drives the **interactive** OAuth flow — it opens the browser on the agent
host and waits for the loopback callback.

> The silent KYA flow is fully non-interactive, so it works even when the client
> surface is remote. The interactive flow opens the browser on the agent host and
> redirects to a loopback callback there, so it only completes when the browser and
> agent share a machine (i.e. local dev) unless a custom `oauth.redirectUri` is
> configured. A truly remote client would need a split start → open-in-user-browser →
> callback flow with a client-hosted redirect.

---

## Testing the interactive OAuth fallback

KYA is an optimization layered on top of standard OAuth. To exercise the interactive
Authorization Code + PKCE fallback locally, run the harness with KYA **disabled** so
the AS behaves like a vanilla OAuth server:

- The AS omits `kya` from `authorization_grant_profiles_supported` and serves an
  auto-approving `/authorize` endpoint plus an `authorization_code` token grant
  (PKCE `S256` enforced).
- Configure **only** the protected server — no KYA issuer is needed.
- Connect the server. Since KYA isn't advertised, the status becomes `needs_auth`
  with no toggle required; complete it via the agent's interactive auth command,
  which opens the browser at `/authorize`, auto-approves, redirects to the loopback
  callback, exchanges the code at `/token`, and stores the access token.

> The interactive-fallback toggle is only needed for the **other** branch: when a
> server **does** advertise KYA but no issuer is configured. There the default is a
> hard failure, and the toggle makes it fall through to interactive instead.

---

## Verifying the mint + MCP auth

### Agent logs

With debug logging enabled, the agent prints non-sensitive markers during the flow:

- `===== KYA auth flow BEGIN =====` / `===== KYA auth flow END =====` (flow boundaries)
- discovery: fetching protected-resource metadata, AS grant profiles
- `calling issuer KYA tool`, `skyfire tool response`, `extracted assertion`
- `exchanging assertion for access token`, `token exchange success`, `stored access token`
- on a tool-call 401: a `401 RECEIVED` marker, then the silent mint + retry

### AS logs

The AS logs each request and the token exchange — the incoming grant type and
assertion, signature verification against the issuer JWKS, and the issued access
token (token values truncated).

---

## Troubleshooting

### `SSE error: Non-200 status code (404)`

The client attempted SSE against a StreamableHTTP-only server. SSE 404 is treated as
"unsupported," so it should not block the StreamableHTTP connection.

### `Could not extract JWT assertion from issuer tool output`

The issuer tool did not return a string containing a JWT assertion.

- Confirm the KYA issuer (the remote server with `capabilities["org.kyapay:kya"].tool`)
  is configured and reachable.
- Confirm its API-key header is set.

### `create-kya-token` returns a "seller not found" / 4xx error

The seller selector sent to the issuer isn't registered in the seller directory for
the API key's environment.

- Pin a known seller by UUID via the `sellerServiceId` override.
- Public server: confirm its domain is registered as a seller in the issuer
  environment matching your API key.
- Localhost server: confirm the placeholder domain is registered as a seller in that
  environment, or set the `sellerServiceId` override to bypass the URL-derived path.

### `invalid_grant` at the token exchange

The AS rejected the assertion. Common causes: the AS trusts a different issuer
environment (issuer/JWKS mismatch), an expected claim (`env`, `sdm`, `typ`) doesn't
match the AS's configuration, or the assertion is expired/replayed. Compare the
assertion's claims against what the AS validates.
