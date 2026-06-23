# XYZ-Clothiers Mock MCP Server

A mock MCP server that reproduces the observed **XYZ-Clothiers** tool surface (an
Auth0/Okta swag store) with a toggleable auth gate that mimics Skyfire KYA protection.

It mirrors the auth pattern from `../merchant-mcp/merchant.js` (HTTP MCP on `/mcp`,
401 + `WWW-Authenticate` challenge for unauthenticated connections) but exposes the
`getCategories` / `addToCart` / `checkout` / ... tools instead of the
`search-for-products` / `pay` toolset.

This directory has two processes:

- **`server.js`** — the mock MCP resource (port `8799`). Serves the swag tools and
  gates the protected ones behind a Bearer access token.
- **`auth-server.js`** — a mock OAuth Authorization Server (port `8788`). Exchanges a
  **real Skyfire KYA token** for an access token via the `jwt-bearer` grant, then
  `server.js` accepts that access token.

## Tools

### Open (no auth)

| Tool                  | Notes                                                          |
| --------------------- | ------------------------------------------------------------- |
| `getCategories`       | List swag categories (with IDs)                               |
| `getFeaturedProducts` | Featured items (`limit`); each result includes its product ID and slug |
| `getProduct`          | Product detail by `slug` (full JSON, includes `id`)           |
| `searchProducts`      | Search (`query`, `categoryId`, `minPrice`, `maxPrice`, `limit`); results include product ID and slug |
| `getCart`             | Returns an empty "Sign in to start adding items" state when unauthenticated |

The catalog tools surface each product's `id` (e.g. `prod-hoodie-zip`), which is the
value `addToCart` expects as `productId` — so a client can browse, grab an ID, and add
to cart without guessing.

### Protected (auth required)

| Tool                | Purpose                            |
| ------------------- | ---------------------------------- |
| `addToCart`         | Add item (`productId`, `quantity`) |
| `removeFromCart`    | Remove item (`productId`)          |
| `clearCart`         | Empty the cart                     |
| `checkout`          | Create a checkout session          |
| `getOrder`          | Order details (`orderId`)          |
| `getPreviousOrders` | Order history (`limit`, `offset`)  |

Open tools (catalog browsing) work with **no token**, so a client can connect, list
tools, and browse freely. Calling a protected tool (e.g. `addToCart`) without a valid
access token returns an HTTP **`401`** with a `WWW-Authenticate` challenge (RFC 9728) —
this is what kicks off the KYA token exchange. So the client connects, browses, and
only hits the `401` when it *first* calls a protected tool.

## Run

Install deps (the auth server uses `jose` for JWKS verification), then start both
processes.

**Both at once** (one terminal, prefixed output, Ctrl-C stops both):

```bash
cd xyz-clothiers-mock
npm install
npm run dev          # or: node dev.js  /  npm run start:all
```

**Separately** (two terminals):

```bash
node auth-server.js  # authorization server (port 8788)
node server.js       # MCP resource (port 8799)
```

Endpoints:

- MCP: `http://127.0.0.1:8799/mcp`
- Resource metadata: `http://127.0.0.1:8799/.well-known/oauth-protected-resource`
- AS discovery: `http://127.0.0.1:8788/.well-known/oauth-authorization-server`
- Token exchange: `http://127.0.0.1:8788/oauth/token`

## Auth flow: KYA token → access token → protected tools

The mock MCP server points its `authorization_servers` at the mock auth server
(`http://127.0.0.1:8788` by default). The end-to-end flow:

1. A client connects to `/mcp` with no token → `401` + `WWW-Authenticate` pointing
   at the resource metadata and the AS.
2. The client obtains a **real Skyfire KYA token** (e.g. from `create-kya-token` on
   `mcp-qa.skyfire.xyz`).
3. The client POSTs it to the auth server's token endpoint using the `jwt-bearer`
   grant:

   ```bash
   curl -X POST http://127.0.0.1:8788/oauth/token \
     -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer \
     -d assertion=<SKYFIRE_KYA_TOKEN>
   ```

   The auth server verifies the assertion's signature against **Skyfire's live
   JWKS** (`app-qa.skyfire.xyz`), checks issuer/expiry/replay, then returns an
   HS256 `access_token`.
4. The client calls `/mcp` with `Authorization: Bearer <access_token>`. The MCP
   server verifies the token (signature, `iss`, `aud`, `exp`, and the `mcp` scope)
   and unlocks the protected tools.

KYA tokens are **not** minted by this mock — they must come from Skyfire. The auth
server and MCP server share `ACCESS_TOKEN_SECRET` so the issued access token is
verifiable on the resource side.

## Discovery metadata (RFC 9728)

The mock serves `.well-known/oauth-protected-resource` with the same shape as the
real XYZ-Clothiers server (`https://store.auth101.dev`):

```json
{
  "resource": "http://127.0.0.1:8799/mcp",
  "authorization_servers": ["http://127.0.0.1:8788"],
  "resource_name": "Auth101 Swag MCP Server",
  "scopes_supported": ["openid", "profile", "email"]
}
```

The real server delegates auth to a separate Auth0 tenant
(`https://auth0.store.auth101.dev`). The mock defaults `authorization_servers` to
the mock auth server (`http://127.0.0.1:8788`). `server.js` also answers
`.well-known/oauth-authorization-server` (RFC 8414) for convenience, but since it
doesn't mint tokens itself, that metadata simply mirrors the real auth server's
endpoints (`AUTH_SERVER`) rather than advertising routes on its own origin. Set
`AUTH_SERVER=<url>` to point at a different authorization server, and
`RESOURCE_NAME=<name>` to override the advertised name.

The unauthenticated 401 from `/mcp` includes a matching `WWW-Authenticate`
challenge with `resource_metadata` and `authorization-uri` pointers.

## Environment variables

### MCP server (`server.js`)

- `REQUIRE_AUTH=0` — run fully open (no 401, protected tools succeed). Useful for
  quick local testing without the auth server.
- `ACCEPT_ANY_TOKEN=1` — accept any non-empty Bearer token instead of verifying a
  real access token (skips signature/iss/aud/exp checks).
- `ACCESS_TOKEN_SECRET=<secret>` — HS256 secret used to verify access tokens. Must
  match the auth server's value. Default: `mock-access-dev-secret`.
- `AUTH_SERVER=<url>` — authorization server advertised in metadata + used as the
  expected token `iss`. Default: `http://127.0.0.1:8788`.
- `RESOURCE_NAME=<name>` — `resource_name` in resource metadata.
- `PORT`, `HOST`, `PUBLIC_BASE_URL` — network overrides.

### Auth server (`auth-server.js`)

- `ACCESS_TOKEN_SECRET=<secret>` — HS256 secret used to sign access tokens. Must
  match the MCP server's value.
- `MOCK_MCP_RESOURCE_URI=<url>` — `aud` baked into issued access tokens. Must equal
  the MCP server's `/mcp` URL. Default: `http://127.0.0.1:8799/mcp`.
- `MOCK_SKYFIRE_JWKS_URL` / `MOCK_SKYFIRE_ISSUER` — Skyfire JWKS + issuer used to
  verify KYA tokens. Default: Skyfire QA (`https://app-qa.skyfire.xyz`).
- `MOCK_SKYFIRE_ENV` — expected `env` claim. Default: `qa`. Also selects the issuer
  from the built-in `production`/`sandbox`/`qa` map when `MOCK_SKYFIRE_ISSUER` is unset.
- `MOCK_SKYFIRE_ALG` — JWS algorithm the assertion must be signed with. Default:
  `ES256` (what Skyfire uses, per the official `verifyToken` example).
- `MOCK_SKYFIRE_EXPECTED_TYP` — required JWT header `typ`. Default: `kya+jwt`. Set to
  an empty string to skip the `typ` check.
- `MOCK_SKYFIRE_EXPECTED_SDM` — required seller-domain (`sdm`) claim. Default: unset
  (the `sdm` check is **skipped**), because the seller domain is chosen by the
  client/Skyfire at mint time and varies per target (e.g. `auth101.dev`,
  `mcp-server.com`). Set it to enforce a specific seller.
- `AUTH_PORT`, `HOST`, `AUTH_PUBLIC_BASE_URL` — network overrides.

KYA assertion validation follows Skyfire's official
[`verifyKyaTokenToExternalSeller`](https://github.com/skyfire-xyz/kyapay/blob/main/code-examples/verifyToken/typescript/src/verifyKyaTokenToExternalSeller.ts)
example: signature (pinned `ES256`) + issuer, header `typ`, the common claims
(`env`, `iat`, `jti` as a UUID, `exp`), the seller domain (`sdm`), and the KYA
identity (`hid.email`).

## Logging

Both servers log in a compact `[functionName] message ...` format (tokens are
truncated in output), so you can trace the full handshake — token verification,
the gate decision, and each tool dispatch — directly in each process's stdout.

## Wire into opencode

```jsonc
{
  "mcp": {
    "xyz-clothiers-mock": {
      "type": "remote",
      "enabled": true,
      "url": "http://127.0.0.1:8799/mcp"
    }
  }
}
```
