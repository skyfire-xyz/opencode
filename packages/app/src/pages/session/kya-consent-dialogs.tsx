import { useSDK } from "@/context/sdk"
import { onCleanup } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context"
import { DialogKyaConsent } from "@/components/dialog-kya-consent"

// Auto-opens the "Sign in with Skyfire KYA" prompt when a gated tool call on a
// KYA-advertising MCP server returns 401 (server emits mcp.kya.consent.required).
// Approving mints a token via kyaAuthorize without reconnecting; the agent then
// retries the tool. `sdk` is already scoped to the current directory, so events
// are for this session's context.
export function useKyaConsentDialogs() {
  const sdk = useSDK()
  const dialog = useDialog()

  onCleanup(
    sdk.event.on("mcp.kya.consent.required", (evt) => {
      // Don't stack on top of an open dialog; the agent's next gated retry will
      // re-emit the event if the user dismisses this one.
      if (dialog.active) return
      dialog.show(() => <DialogKyaConsent name={evt.properties.name} mode="authorize" />)
    }),
  )
}
