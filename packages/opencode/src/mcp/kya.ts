import { Flag } from "@opencode-ai/core/flag/flag"

export function kyaIssuerServerNames(): string[] {
  const raw = Flag.OPENCODE_KYA_ISSUER_SERVERS
  if (!raw) return []
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
}
