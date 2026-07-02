import { describe, expect, test } from "bun:test"
import { executeWithGateway, type CapabilityMap } from "../../src/mcp/gateway"

// Minimal CallToolResult shapes. The merchant's first response carries the
// payment signal in _meta (isError + settlement types + order total); the
// issuer mints a token in plain text content; the merchant's retry succeeds.
const paymentSignal = {
  isError: true,
  content: [{ type: "text", text: "Payment required" }],
  _meta: {
    "payments/settlement/types": ["org.kyapay:pay:card"],
    "payments/amount/total": 42.5,
    "payments/amount/sub-total": 40,
    "payments/amount/taxes": 1.5,
    "payments/amount/shipping_and_handling": 1,
    "payments/settlement/currency": "USD",
    "payments/settlement/seller_service_id": "seller-123",
  },
}

const issuerToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwYXkifQ.signature_part_that_is_long_enough_to_match"

function makeMerchant() {
  const calls: Array<{ name: string; meta: unknown }> = []
  const client = {
    callTool: async (params: any) => {
      calls.push({ name: params.name, meta: params._meta })
      // First call → payment signal; retry (token injected) → success.
      if (params._meta?.["payments/settlement/token"]) {
        return { isError: false, content: [{ type: "text", text: "Order placed" }] }
      }
      return paymentSignal
    },
  }
  return { client, calls }
}

function makeIssuer() {
  const calls: Array<{ name: string; args: unknown }> = []
  const client = {
    callTool: async (params: any) => {
      calls.push({ name: params.name, args: params.arguments })
      return { isError: false, content: [{ type: "text", text: `token: ${issuerToken}` }] }
    },
  }
  return { client, calls }
}

const capabilityMap: CapabilityMap = {
  "org.kyapay:pay": [{ server: "issuer", tool: "create-pay-token" }],
}

describe("executeWithGateway pay consent", () => {
  test("approving mints a token and retries the original tool", async () => {
    const merchant = makeMerchant()
    const issuer = makeIssuer()
    let consentInfo: any
    const requestPayConsent = async (info: any) => {
      consentInfo = info
      return true
    }

    const result = await executeWithGateway({
      toolName: "pay",
      args: { cartId: "c1" },
      client: merchant.client as any,
      clients: { issuer: issuer.client as any },
      capabilityMap,
      requestPayConsent,
    })

    // Consent was asked with the parsed order breakdown.
    expect(consentInfo).toMatchObject({
      total: 42.5,
      currency: "USD",
      subTotal: 40,
      taxes: 1.5,
      shippingAndHandling: 1,
      settlementType: "org.kyapay:pay:card",
    })
    // Issuer was asked to mint.
    expect(issuer.calls).toHaveLength(1)
    expect(issuer.calls[0].name).toBe("create-pay-token")
    // Original tool retried with the settlement token injected.
    const retry = merchant.calls.find((c) => (c.meta as any)?.["payments/settlement/token"])
    expect(retry).toBeDefined()
    expect((retry!.meta as any)["payments/settlement/token"]).toBe(issuerToken)
    expect((result as any).isError).toBeFalsy()
  })

  test("declining aborts without minting", async () => {
    const merchant = makeMerchant()
    const issuer = makeIssuer()
    const requestPayConsent = async () => false

    const result = await executeWithGateway({
      toolName: "pay",
      args: { cartId: "c1" },
      client: merchant.client as any,
      clients: { issuer: issuer.client as any },
      capabilityMap,
      requestPayConsent,
    })

    // No mint, no retry.
    expect(issuer.calls).toHaveLength(0)
    expect(merchant.calls.some((c) => (c.meta as any)?.["payments/settlement/token"])).toBe(false)
    expect((result as any).isError).toBe(true)
    expect((result as any).content[0].text).toContain("not approved")
  })
})
