import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { CallToolResultSchema, type CallToolRequest } from "@modelcontextprotocol/sdk/types.js"
import type { ConfigMCP } from "../config/mcp"
import * as Log from "@opencode-ai/core/util/log"
import open from "open"

const log = Log.create({ service: "mcp.gateway" })

type MCPClient = Client
type CallToolResult = Awaited<ReturnType<MCPClient["callTool"]>>
type CallToolParams = CallToolRequest["params"]

// ---------------------------------------------------------------------------
// Payment signal parsing
// ---------------------------------------------------------------------------

interface PaymentSignal {
  settlementTypes: string[]
  currency: string
  total: number
  subTotal?: number
  taxes?: number
  shippingAndHandling?: number
  /** The merchant's identity on the payment network, required by the issuer to mint a token. */
  sellerServiceId?: string
  /** Optional search hint used to look the seller up via find-sellers if no id is supplied. */
  sellerSearch?: string
}

interface MandateSignal {
  url: string
}

function parsePaymentSignal(result: CallToolResult): PaymentSignal | undefined {
  if (!result.isError) return undefined

  const meta = (result as Record<string, unknown>)._meta as Record<string, unknown> | undefined
  if (!meta) return undefined

  const types = meta["payments/settlement/types"]
  if (!Array.isArray(types) || types.length === 0) return undefined

  const total = meta["payments/amount/total"]
  if (typeof total !== "number") return undefined

  return {
    settlementTypes: types as string[],
    currency:
      typeof meta["payments/settlement/currency"] === "string"
        ? (meta["payments/settlement/currency"] as string)
        : "USD",
    total,
    subTotal:
      typeof meta["payments/amount/sub-total"] === "number" ? (meta["payments/amount/sub-total"] as number) : undefined,
    taxes: typeof meta["payments/amount/taxes"] === "number" ? (meta["payments/amount/taxes"] as number) : undefined,
    shippingAndHandling:
      typeof meta["payments/amount/shipping_and_handling"] === "number"
        ? (meta["payments/amount/shipping_and_handling"] as number)
        : undefined,
    sellerServiceId:
      typeof meta["payments/settlement/seller_service_id"] === "string"
        ? (meta["payments/settlement/seller_service_id"] as string)
        : undefined,
    sellerSearch:
      typeof meta["payments/settlement/seller_search"] === "string"
        ? (meta["payments/settlement/seller_search"] as string)
        : undefined,
  }
}

function parseMandateSignal(result: CallToolResult): MandateSignal | undefined {
  if (!result.isError) return undefined

  const meta = (result as Record<string, unknown>)._meta as Record<string, unknown> | undefined
  if (!meta) return undefined
  if (meta["payments/mandates/inline/required"] !== true) return undefined

  const url = meta["payments/mandates/inline/url"]
  if (typeof url !== "string") return undefined
  return { url }
}

// ---------------------------------------------------------------------------
// Seller identity resolution
// ---------------------------------------------------------------------------

/** Pull a seller service id out of an arbitrary find-sellers JSON payload. */
function extractSellerServiceId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const obj = value as Record<string, unknown>
  for (const key of ["sellerServiceId", "serviceId", "id"]) {
    if (typeof obj[key] === "string" && obj[key]) return obj[key] as string
  }
  return undefined
}

/**
 * Resolve the seller service id to pass to the token issuer. Prefers the id the
 * merchant advertised in its payment signal; otherwise falls back to looking the
 * seller up via the issuer's find-sellers tool using the merchant's search hint.
 */
async function resolveSellerServiceId(input: {
  payment: PaymentSignal
  providerClient: MCPClient
  timeout?: number
}): Promise<string | undefined> {
  const { payment, providerClient, timeout } = input
  if (payment.sellerServiceId) return payment.sellerServiceId
  if (!payment.sellerSearch) return undefined

  log.info("gateway: no seller id supplied, searching via find-sellers", { search: payment.sellerSearch })
  const result = await providerClient
    .callTool({ name: "find-sellers", arguments: { search: payment.sellerSearch } }, CallToolResultSchema, {
      resetTimeoutOnProgress: true,
      timeout,
    })
    .catch(() => undefined)

  if (!result || result.isError) {
    log.warn("gateway: find-sellers failed or returned error")
    return undefined
  }

  const content = result.content as Array<{ type: string; text?: string }>
  for (const item of content) {
    if (item.type !== "text" || !item.text) continue
    try {
      const parsed = JSON.parse(item.text)
      const candidates = Array.isArray(parsed) ? parsed : [parsed]
      for (const c of candidates) {
        const id = extractSellerServiceId(c)
        if (id) return id
      }
    } catch {}
  }
  return undefined
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function extractJwtFromText(text: string): string | undefined {
  const m = text.match(/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/)
  return m ? m[1] : undefined
}

function extractTokenFromResponse(result: CallToolResult): string | undefined {
  const content = result.content as Array<{ type: string; text?: string }>
  for (const item of content) {
    if (item.type !== "text" || !item.text) continue
    const token = extractJwtFromText(item.text)
    if (token) return token
  }
  return undefined
}

/** Concatenate the text content of a tool result, for surfacing issuer-side errors. */
function resultText(result: CallToolResult): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n")
    .trim()
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

interface TokenCacheEntry {
  token: string
  exp: number
}

const tokenCache = new Map<string, TokenCacheEntry>()

function cacheKey(settlementType: string, total: number, currency: string) {
  return `${settlementType}:${total}:${currency}`
}

function getCachedToken(settlementType: string, total: number, currency: string): string | undefined {
  const key = cacheKey(settlementType, total, currency)
  const entry = tokenCache.get(key)
  if (!entry) return undefined
  if (Date.now() / 1000 >= entry.exp - 30) {
    tokenCache.delete(key)
    return undefined
  }
  return entry.token
}

function setCachedToken(settlementType: string, total: number, currency: string, token: string) {
  const key = cacheKey(settlementType, total, currency)
  let exp = Date.now() / 1000 + 300
  const parts = token.split(".")
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1]))
      if (typeof payload.exp === "number") exp = payload.exp
    } catch {}
  }
  tokenCache.set(key, { token, exp })
}

// ---------------------------------------------------------------------------
// Capability map (config → server routing)
// ---------------------------------------------------------------------------

export interface CapabilityEntry {
  /** The MCP server name that handles this capability. */
  server: string
  /** The tool on that server to call when minting a token. */
  tool: string
}

export interface CapabilityMap {
  /** Maps a settlement type prefix (e.g. "org.kyapay:pay") to its provider entry. */
  [capability: string]: CapabilityEntry
}

export function buildCapabilityMap(mcpConfig: Record<string, ConfigMCP.Info | { enabled: boolean }>): CapabilityMap {
  const map: CapabilityMap = {}
  for (const [serverName, entry] of Object.entries(mcpConfig)) {
    if (!("type" in entry)) continue
    const info = entry as ConfigMCP.Info
    if (!("capabilities" in info) || !info.capabilities) continue
    for (const [cap, capConfig] of Object.entries(info.capabilities)) {
      map[cap] = { server: serverName, tool: capConfig.tool }
    }
  }
  return map
}

/**
 * Find the provider entry for a given settlement type.
 *
 * Settlement types look like "org.kyapay:pay:card". Capabilities in config
 * are prefixes like "org.kyapay:pay" or "org.kyapay". We match the most
 * specific prefix first.
 */
function findProviderForSettlement(settlementType: string, capabilityMap: CapabilityMap): CapabilityEntry | undefined {
  const parts = settlementType.split(":")
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join(":")
    if (capabilityMap[prefix]) return capabilityMap[prefix]
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Main gateway executor
// ---------------------------------------------------------------------------

export async function executeWithGateway(input: {
  toolName: string
  args: Record<string, unknown>
  client: MCPClient
  clients: Record<string, MCPClient>
  capabilityMap: CapabilityMap
  timeout?: number
}): Promise<CallToolResult> {
  const { toolName, args, client, clients, capabilityMap, timeout } = input

  log.info("gateway: executing tool", { toolName })

  const result = await client.callTool({ name: toolName, arguments: args }, CallToolResultSchema, {
    resetTimeoutOnProgress: true,
    timeout,
  })

  // Check for payments/* signal in _meta
  const payment = parsePaymentSignal(result)
  if (!payment) return result

  log.info("gateway: caught payment signal", {
    toolName,
    settlementTypes: payment.settlementTypes,
    total: payment.total,
    currency: payment.currency,
  })

  // Find a settlement type we can fulfill
  let matchedType: string | undefined
  let provider: CapabilityEntry | undefined

  for (const st of payment.settlementTypes) {
    provider = findProviderForSettlement(st, capabilityMap)
    if (provider) {
      matchedType = st
      break
    }
  }

  if (!matchedType || !provider) {
    log.error("gateway: no provider for any settlement type", {
      requested: payment.settlementTypes,
      available: Object.keys(capabilityMap),
    })
    return result
  }

  const providerClient = clients[provider.server]
  if (!providerClient) {
    log.error("gateway: provider server not connected", { server: provider.server })
    return result
  }

  log.info("gateway: matched settlement type", {
    settlementType: matchedType,
    provider: provider.server,
    tool: provider.tool,
  })

  // Check cache first
  let token = getCachedToken(matchedType, payment.total, payment.currency)

  if (!token) {
    const issuerTool = provider.tool

    // Build the _meta to forward payment details to the token issuer
    const issuerMeta: Record<string, unknown> = {
      "payments/amount/total": payment.total,
      "payments/settlement/currency": payment.currency,
    }
    if (payment.subTotal !== undefined) issuerMeta["payments/amount/sub-total"] = payment.subTotal
    if (payment.taxes !== undefined) issuerMeta["payments/amount/taxes"] = payment.taxes
    if (payment.shippingAndHandling !== undefined)
      issuerMeta["payments/amount/shipping_and_handling"] = payment.shippingAndHandling

    const sellerServiceId = await resolveSellerServiceId({ payment, providerClient, timeout })
    if (!sellerServiceId) {
      log.error("gateway: could not resolve seller service id for issuer", { server: provider.server })
      return {
        content: [
          {
            type: "text" as const,
            text: "Gateway error: the merchant did not provide a seller identity and one could not be resolved, so a payment token could not be issued.",
          },
        ],
        isError: true,
      }
    }

    log.info("gateway: calling token issuer", {
      server: provider.server,
      tool: issuerTool,
      total: payment.total,
      currency: payment.currency,
      sellerServiceId,
    })

    const tokenResult = await providerClient.callTool(
      {
        name: issuerTool,
        arguments: {
          amount: String(payment.total),
          sellerServiceId,
        },
        _meta: issuerMeta,
      } as CallToolParams,
      CallToolResultSchema,
      { resetTimeoutOnProgress: true, timeout },
    )

    // Check if the issuer requires a mandate (browser-based authorization)
    const mandate = parseMandateSignal(tokenResult)
    if (mandate) {
      log.info("gateway: issuer requires inline mandate", { url: mandate.url })
      await open(mandate.url)
      return {
        content: [
          {
            type: "text" as const,
            text: "Payment authorization required. A browser window has been opened for you to approve the payment. Please retry after authorizing.",
          },
        ],
        isError: true,
      }
    }

    if (tokenResult.isError) {
      log.error("gateway: token issuer returned error", {
        server: provider.server,
        tool: issuerTool,
        detail: resultText(tokenResult),
      })
      return tokenResult
    }

    token = extractTokenFromResponse(tokenResult)
    if (!token) {
      // The issuer may report failures (e.g. insufficient balance) in plain
      // content text with isError unset, so surface that text rather than a
      // generic "failed to extract" message.
      const detail = resultText(tokenResult)
      log.error("gateway: could not extract token from issuer response", { server: provider.server, detail })
      return {
        content: [
          {
            type: "text" as const,
            text: detail
              ? `Gateway error: the payment issuer did not return a token. Issuer said: ${detail}`
              : "Gateway error: failed to extract payment token from issuer.",
          },
        ],
        isError: true,
      }
    }

    setCachedToken(matchedType, payment.total, payment.currency, token)
    log.info("gateway: acquired and cached token", { server: provider.server })
  } else {
    log.info("gateway: using cached token", { settlementType: matchedType })
  }

  // Build the payment _meta for the merchant's pay tool
  const paymentMeta: Record<string, unknown> = {
    "payments/settlement/type": matchedType,
    "payments/settlement/token": token,
    "payments/amount/total": payment.total,
    "payments/settlement/currency": payment.currency,
  }

  // Retry the original tool with the payment token injected in _meta
  log.info("gateway: retrying original tool with payment token", { toolName })
  const retryResult = await client.callTool(
    {
      name: toolName,
      arguments: args,
      _meta: paymentMeta,
    } as CallToolParams,
    CallToolResultSchema,
    { resetTimeoutOnProgress: true, timeout },
  )

  log.info("gateway: retry completed", { toolName, isError: retryResult.isError ?? false })
  return retryResult
}
