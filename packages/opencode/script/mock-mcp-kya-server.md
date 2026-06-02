# Mock MCP (KYA) Server

This is a tiny local HTTP server that simulates:

- an MCP server at `/mcp` that requires `Authorization: Bearer <oauth-access-token>`
- a separate OAuth Resource Authorization Server that advertises `authorization_grant_profiles_supported: ["kya"]`
- a `/token` endpoint supporting `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`

It **does not validate JWT signatures**; it only checks that the `assertion` looks like a JWT.

## Run

```bash
cd packages/opencode
MOCK_MCP_PORT=8787 MOCK_AUTH_PORT=8788 bun run ./script/mock-mcp-kya-server.ts
```

## Configure OpenCode

In `.opencode/opencode.jsonc`, add a remote MCP entry pointing at the mock server:

```jsonc
{
  "mcp": {
    "mock-kya": {
      "type": "remote",
      "url": "http://127.0.0.1:8787/mcp",
      "oauth": {
        "kya": {
          "tokenType": "kya",
          "buyerTag": "test",
          "tokenAmount": 1,
        },
      },
    },
  },
}
```

Then export env vars for your real Skyfire endpoint and API key:

```bash
export OPENCODE_KYA_CREATE_TOKEN_URL="https://api-qa.skyfire.xyz/api/v1/tokens"
export OPENCODE_SKYFIRE_API_KEY="<your-key>"
```

Now, in the web app, connect/authenticate the `mock-kya` MCP server. You should see the backend:

1. call Skyfire to get a `{ token }`
2. call the mock auth server `POST http://127.0.0.1:8788/token` to exchange the assertion for an access token
3. call the MCP server `/mcp` endpoint with `Authorization: Bearer mock_access_...`
