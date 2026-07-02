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
  /**
   * Accepted issuer origins keyed by settlement type. A type the merchant
   * constrains (e.g. COIN) lists the issuers it will settle with; a type absent
   * from this map (or the map being absent entirely) carries no issuer
   * constraint and matches any provider, as before.
   */
  issuersByType?: Record<string, string[]>
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

  // Validate payments/settlement/issuers as an object of type → string[]. Drop
  // malformed entries; an empty/absent map means no issuer constraints.
  let issuersByType: Record<string, string[]> | undefined
  const issuersRaw = meta["payments/settlement/issuers"]
  if (issuersRaw && typeof issuersRaw === "object" && !Array.isArray(issuersRaw)) {
    const parsed: Record<string, string[]> = {}
    for (const [type, list] of Object.entries(issuersRaw as Record<string, unknown>)) {
      if (Array.isArray(list) && list.every((v) => typeof v === "string")) parsed[type] = list as string[]
    }
    if (Object.keys(parsed).length > 0) issuersByType = parsed
  }

  return {
    settlementTypes: types as string[],
    issuersByType,
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
  // Anchor on the JWT header prefix `eyJ` so a domain in the message (e.g.
  // "store.auth101.dev") isn't matched as a `word.word.word` token before the JWT.
  const m = text.match(/(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/)
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
// Capability map (config → server routing)
// ---------------------------------------------------------------------------

export interface CapabilityEntry {
  /** The MCP server name that handles this capability. */
  server: string
  /** The tool on that server to call when minting a token. */
  tool: string
  /**
   * The provider's issuer identity: the origin of its configured server url
   * (e.g. https://mcp-qa.skyfire.xyz/mcp → https://mcp-qa.skyfire.xyz). Only
   * remote providers have one; local providers leave this undefined.
   */
  issuer?: string
}

export interface CapabilityMap {
  /**
   * Maps a settlement type prefix (e.g. "org.kyapay:pay") to the providers that
   * can fulfill it. There can be more than one when several configured servers
   * declare the same capability with different issuer identities; the gateway
   * picks the one whose issuer the merchant accepts.
   */
  [capability: string]: CapabilityEntry[]
}

export function buildCapabilityMap(mcpConfig: Record<string, ConfigMCP.Info | { enabled: boolean }>): CapabilityMap {
  const map: CapabilityMap = {}
  for (const [serverName, entry] of Object.entries(mcpConfig)) {
    if (!("type" in entry)) continue
    const info = entry as ConfigMCP.Info
    // A disabled server is never connected, so it can never mint — drop it as a
    // candidate up front (mirrors the `enabled === false` guard in `create`).
    if (info.enabled === false) continue
    if (!("capabilities" in info) || !info.capabilities) continue
    // Legacy Remote configs allow capabilities as a plain string[] (URI list).
    // That form has no tool mapping, so it produces no capability map entries.
    // It is handled separately by hasKyaCapability/kyaCapabilityTool in kya.ts.
    if (Array.isArray(info.capabilities)) continue
    // Derive the provider's issuer identity from its server url origin. Local
    // providers have no url, so they carry no issuer constraint.
    let issuer: string | undefined
    if (info.type === "remote" && typeof info.url === "string") {
      try {
        issuer = new URL(info.url).origin
      } catch {
        issuer = undefined
      }
    }
    for (const [cap, capConfig] of Object.entries(info.capabilities)) {
      // `tool` is optional in the schema; an entry without one can't mint.
      if (!capConfig.tool) continue
      // Append rather than overwrite: multiple servers may declare the same
      // capability (different issuers), and we want all of them as candidates.
      map[cap] ??= []
      map[cap].push({ server: serverName, tool: capConfig.tool, issuer })
    }
  }
  return map
}

/**
 * Find the candidate provider entries for a given settlement type.
 *
 * Settlement types look like "org.kyapay:pay:coin". Capabilities in config
 * are prefixes like "org.kyapay:pay" or "org.kyapay". We match the most
 * specific prefix first and return every provider registered under it.
 */
function findProvidersForSettlement(settlementType: string, capabilityMap: CapabilityMap): CapabilityEntry[] {
  const parts = settlementType.split(":")
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join(":")
    if (capabilityMap[prefix]) return capabilityMap[prefix]
  }
  return []
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
  /**
   * Consent gate invoked once a payment signal is caught and a provider/seller
   * are resolved, immediately before a pay token is minted. Returns whether the
   * user approved the charge; a `false` result aborts without minting. When
   * unset, payment proceeds without a prompt (e.g. non-interactive contexts).
   */
  requestPayConsent?: (info: {
    total: number
    currency: string
    subTotal?: number
    taxes?: number
    shippingAndHandling?: number
    settlementType: string
    settlementTypes: string[]
  }) => Promise<boolean>
}): Promise<CallToolResult> {
  const { toolName, args, client, clients, capabilityMap, timeout, requestPayConsent } = input

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

  // Find a settlement type we can fulfill. Pick the first type that has a
  // capability provider AND, when that type declares accepted issuers (COIN),
  // whose provider's derived issuer origin is in the accepted list. Types with
  // no issuer list (e.g. card) match on provider alone, as before.
  let matchedType: string | undefined
  let provider: CapabilityEntry | undefined
  let issuerRejected = false

  for (const st of payment.settlementTypes) {
    const candidates = findProvidersForSettlement(st, capabilityMap)
    if (candidates.length === 0) continue
    const acceptedIssuers = payment.issuersByType?.[st]
    if (acceptedIssuers && acceptedIssuers.length > 0) {
      // Closed-loop type: scan the candidates for one whose derived issuer
      // origin the merchant accepts. Only that provider may mint.
      const accepted = candidates.find((c) => c.issuer && acceptedIssuers.includes(c.issuer))
      if (!accepted) {
        log.warn("gateway: no candidate provider has an accepted issuer for settlement type", {
          settlementType: st,
          candidateIssuers: candidates.map((c) => c.issuer),
          acceptedIssuers,
        })
        issuerRejected = true
        continue
      }
      provider = accepted
    } else {
      // No issuer constraint (e.g. card): the first candidate fulfills it.
      provider = candidates[0]
    }
    matchedType = st
    break
  }

  if (!matchedType || !provider) {
    // Distinguish (b) "a provider exists but no accepted issuer matched" from
    // (a) "no provider at all". For (b) we must NOT silently mint from an
    // unaccepted issuer — that would defeat closed-loop COIN — so surface a
    // gateway error result rather than the merchant's original payment-required.
    if (issuerRejected) {
      log.error("gateway: issuer not accepted by merchant", {
        requested: payment.settlementTypes,
        issuersByType: payment.issuersByType,
        available: Object.keys(capabilityMap),
      })
      return {
        content: [
          {
            type: "text" as const,
            text: "Gateway error: a payment provider is available, but its issuer identity is not accepted by the merchant for the requested settlement type(s). No payment token was minted.",
          },
        ],
        isError: true,
      }
    }
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

  // Mint a fresh token. Pay tokens are minted for one-time use only, so we
  // never cache or reuse them — every payment signal triggers a new mint.
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

  // Human-in-the-loop consent: the order total is now known and payment can
  // proceed, so confirm the charge before minting. Declining (or timing out)
  // aborts without minting a token.
  if (requestPayConsent) {
    const approved = await requestPayConsent({
      total: payment.total,
      currency: payment.currency,
      subTotal: payment.subTotal,
      taxes: payment.taxes,
      shippingAndHandling: payment.shippingAndHandling,
      settlementType: matchedType,
      settlementTypes: payment.settlementTypes,
    })
    if (!approved) {
      log.info("gateway: payment not approved by user", { toolName, total: payment.total })
      return {
        content: [
          {
            type: "text" as const,
            text: "Payment was not approved by the user. No payment token was minted.",
          },
        ],
        isError: true,
      }
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

  const token = extractTokenFromResponse(tokenResult)
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

  log.info("gateway: acquired token", { server: provider.server })

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
