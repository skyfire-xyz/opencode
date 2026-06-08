import { ConfigMCP } from "@/config/mcp"

/** Capability URI an MCP server advertises to act as a KYA token issuer. */
export const KYA_CAPABILITY = "org.kyapay:kya"

/** Whether an MCP server config advertises the KYA issuer capability. */
export function hasKyaCapability(config: ConfigMCP.Info | undefined): boolean {
  return !!config && "capabilities" in config && !!config.capabilities?.includes(KYA_CAPABILITY)
}

/** Find the first configured remote MCP server that advertises the KYA capability. */
export function kyaIssuerFromConfig(
  config: Record<string, ConfigMCP.Info> | undefined,
): [string, ConfigMCP.Remote] | undefined {
  return Object.entries(config ?? {}).find(
    (entry): entry is [string, ConfigMCP.Remote] => hasKyaCapability(entry[1]),
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
 * Probe the MCP endpoint unauthenticated (spec B1) and read the RFC 9728
 * `resource_metadata` pointer from the 401 `WWW-Authenticate` header (B2).
 *
 * Returns `undefined` when the server doesn't 401 or doesn't advertise a
 * pointer, in which case callers fall back to the default well-known location.
 */
export async function probeResourceMetadataUrl(serverUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
    })
    if (res.status !== 401) return undefined
    const wwwAuth = res.headers.get("www-authenticate")
    const m = wwwAuth?.match(/resource_metadata="?([^",\s]+)"?/i)
    return m?.[1]
  } catch {
    return undefined
  }
}

/**
 * Discover the Resource Authorization Server's token endpoint for an MCP server
 * via the spec discovery chain: probe for a 401 `resource_metadata` pointer
 * (B1–B2) → RFC 9728 protected-resource metadata (B3–B4) → RFC 8414 AS metadata
 * (B5), falling back to the default well-known location and to OpenID configuration.
 */
export async function discoverResourceAuthServer(
  serverUrl: string,
): Promise<{ authServer: string; tokenEndpoint: string } | undefined> {
  const resourceOrigin = new URL(serverUrl).origin
  const resourceMetadataUrl =
    (await probeResourceMetadataUrl(serverUrl)) ??
    new URL("/.well-known/oauth-protected-resource", resourceOrigin).toString()
  const protectedRes = await fetch(resourceMetadataUrl, {
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
