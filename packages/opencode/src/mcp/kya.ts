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
