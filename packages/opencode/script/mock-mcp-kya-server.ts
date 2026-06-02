import http from "http"

function json(res: http.ServerResponse, status: number, body: unknown, headers?: Record<string, string>) {
  res.writeHead(status, { "content-type": "application/json", ...(headers ?? {}) })
  res.end(JSON.stringify(body))
}

function text(res: http.ServerResponse, status: number, body: string, headers?: Record<string, string>) {
  res.writeHead(status, { "content-type": "text/plain", ...(headers ?? {}) })
  res.end(body)
}

const mcpPort = Number(process.env.MOCK_MCP_PORT ?? "8787")
const authPort = Number(process.env.MOCK_AUTH_PORT ?? "8788")

const authOrigin = `http://127.0.0.1:${authPort}`
const mcpOrigin = `http://127.0.0.1:${mcpPort}`

// In-memory token store: access_token -> assertion prefix (debug only)
const issuedTokens = new Set<string>()

// In-memory OAuth client registrations
let clientSeq = 0

const authServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", authOrigin)

  // --- OAuth / OIDC discovery (Resource Authorization Server metadata) ---
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    return json(res, 200, {
      issuer: authOrigin,
      authorization_endpoint: `${authOrigin}/authorize`,
      token_endpoint: `${authOrigin}/token`,
      registration_endpoint: `${authOrigin}/register`,
      response_types_supported: ["code"],
      authorization_grant_profiles_supported: ["kya"],
    })
  }

  if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
    return json(res, 200, {
      issuer: authOrigin,
      authorization_endpoint: `${authOrigin}/authorize`,
      token_endpoint: `${authOrigin}/token`,
      registration_endpoint: `${authOrigin}/register`,
      response_types_supported: ["code"],
      authorization_grant_profiles_supported: ["kya"],
    })
  }

  // --- OAuth dynamic client registration ---
  if (req.method === "POST" && url.pathname === "/register") {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      // The SDK sends JSON client metadata. We don't validate it for the mock.
      try {
        if (raw.trim().length > 0) JSON.parse(raw)
      } catch {
        return json(res, 400, { error: "invalid_client_metadata" })
      }

      clientSeq += 1
      const clientId = `mock_client_${clientSeq}`
      return json(res, 201, {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
        // Echo back a minimal redirect URI list in case clients inspect it.
        redirect_uris: [],
      })
    })
    return
  }

  // --- OAuth token endpoint (jwt-bearer) ---
  if (req.method === "POST" && url.pathname === "/token") {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const params = new URLSearchParams(raw)
      const grantType = params.get("grant_type")
      const assertion = params.get("assertion")

      if (grantType !== "urn:ietf:params:oauth:grant-type:jwt-bearer") {
        return json(res, 400, { error: "unsupported_grant_type" })
      }
      if (!assertion) {
        return json(res, 400, { error: "invalid_request", error_description: "missing assertion" })
      }

      // Very lightweight validation: accept assertions that look like JWTs
      // and optionally contain the expected audience marker.
      const parts = assertion.split(".")
      if (parts.length < 2) {
        return json(res, 401, { error: "invalid_grant", error_description: "assertion is not a JWT" })
      }

      // Mint an opaque access token tied to the assertion (no signature validation).
      const access = `mock_access_${Buffer.from(assertion).toString("base64url").slice(0, 16)}`
      issuedTokens.add(access)

      // eslint-disable-next-line no-console
      console.log("mock oauth issued access token", {
        grantType,
        accessTokenPrefix: access.slice(0, 20),
      })

      return json(res, 200, {
        access_token: access,
        token_type: "Bearer",
        expires_in: 3600,
        scope: params.get("scope") ?? undefined,
      })
    })
    return
  }

  return text(res, 404, "Not found")
})

const mcpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", mcpOrigin)

  // --- OAuth Protected Resource Metadata (RFC 9728) ---
  // The MCP SDK uses this to discover the authorization server for a protected
  // resource URL. Without it, it falls back to treating the MCP origin itself
  // as the authorization server (and will try POST /register on 8787).
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    return json(res, 200, {
      resource: mcpOrigin,
      authorization_servers: [authOrigin],
    })
  }

  // --- MCP endpoint (fake) ---
  // The MCP client sends JSON-RPC POSTs. We only enforce Bearer auth.
  if (req.method === "POST" && url.pathname === "/mcp") {
    const auth = req.headers.authorization
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined
    if (!token || !issuedTokens.has(token)) {
      // Signal OAuth discovery via standard metadata locations.
      return text(res, 401, "Unauthorized", {
        "www-authenticate": `Bearer realm=\"mcp\", authorization-uri=\"${authOrigin}/.well-known/oauth-authorization-server\"`,
      })
    }

    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      // Minimal JSON-RPC initialize response. This is enough for many clients
      // to consider the server connected.
      let parsed: any
      try {
        parsed = JSON.parse(raw)
      } catch {
        return json(res, 400, { error: "invalid_json" })
      }

      const id = parsed?.id ?? 1
      const method = parsed?.method

      if (method === "initialize") {
        return json(res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: parsed?.params?.protocolVersion ?? "2024-11-05",
            serverInfo: { name: "mock-mcp-kya", version: "0.0.1" },
            capabilities: {},
          },
        })
      }

      if (method === "tools/list") {
        return json(res, 200, {
          jsonrpc: "2.0",
          id,
          result: { tools: [] },
        })
      }

      return json(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      })
    })
    return
  }

  return text(res, 404, "Not found")
})

authServer.listen(authPort, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`mock OAuth Auth Server (KYA) listening: ${authOrigin}`)
  // eslint-disable-next-line no-console
  console.log(`  OAuth metadata:  ${authOrigin}/.well-known/oauth-authorization-server`)
  // eslint-disable-next-line no-console
  console.log(`  Token endpoint:  ${authOrigin}/token`)
})

mcpServer.listen(mcpPort, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`mock MCP server listening: ${mcpOrigin}`)
  // eslint-disable-next-line no-console
  console.log(`  MCP endpoint:    ${mcpOrigin}/mcp`)
})
