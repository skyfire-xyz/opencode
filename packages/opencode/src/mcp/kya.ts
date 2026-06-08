import { ConfigMCP } from "@/config/mcp"

/** Find the first configured remote MCP server that advertises the KYA capability. */
export function kyaIssuerFromConfig(
  config: Record<string, ConfigMCP.Info> | undefined,
): [string, ConfigMCP.Remote] | undefined {
  return Object.entries(config ?? {}).find(
    (entry): entry is [string, ConfigMCP.Remote] =>
      "capabilities" in entry[1] && !!entry[1].capabilities?.includes("org.kyapay:kya"),
  )
}

/**
 * Extract a JWT (the KYA assertion) from the Skyfire issuer tool output, which
 * currently returns a human-readable string like:
 * "Creation of KYA token for <id> is complete: <jwt>".
 */
export function extractJwtFromText(input: string): string | undefined {
  const m = input.match(/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/)
  return m ? m[1] : undefined
}

/**
 * Discover the Resource Authorization Server's token endpoint for an MCP server
 * via the spec discovery chain: RFC 9728 (protected-resource metadata) →
 * RFC 8414 (AS metadata), falling back to OpenID configuration.
 */
export async function discoverResourceAuthServer(
  serverUrl: string,
): Promise<{ authServer: string; tokenEndpoint: string } | undefined> {
  const resourceOrigin = new URL(serverUrl).origin
  const protectedRes = await fetch(new URL("/.well-known/oauth-protected-resource", resourceOrigin), {
    headers: { accept: "application/json" },
  })
  if (!protectedRes.ok) return undefined

  const protectedJson = (await protectedRes.json()) as any
  const authServer =
    Array.isArray(protectedJson?.authorization_servers) && typeof protectedJson.authorization_servers[0] === "string"
      ? (protectedJson.authorization_servers[0] as string)
      : undefined
  if (!authServer) return undefined

  const rfc8414 = await fetch(new URL("/.well-known/oauth-authorization-server", authServer), {
    headers: { accept: "application/json" },
  })
  const asJson = rfc8414.ok
    ? await rfc8414.json()
    : await fetch(new URL("/.well-known/openid-configuration", authServer), {
        headers: { accept: "application/json" },
      }).then((r) => (r.ok ? r.json() : undefined))

  const tokenEndpoint =
    asJson && typeof asJson === "object" && typeof (asJson as any).token_endpoint === "string"
      ? ((asJson as any).token_endpoint as string)
      : undefined
  if (!tokenEndpoint) return undefined
  return { authServer, tokenEndpoint }
}

/**
 * Exchange a KYA token (JWT assertion) for an access token at the Resource AS
 * token endpoint, per RFC 7523 (grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer).
 */
export async function exchangeAssertionForAccessToken(
  tokenEndpoint: string,
  assertion: string,
): Promise<string | undefined> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  })
  if (!res.ok) throw new Error(`OAuth token exchange failed (${res.status}): ${await res.text()}`)
  const json = (await res.json()) as any
  return json && typeof json.access_token === "string" ? json.access_token : undefined
}
