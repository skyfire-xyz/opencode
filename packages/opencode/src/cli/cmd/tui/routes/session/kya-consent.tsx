import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { errorMessage } from "@/util/error"

// TUI counterpart of packages/app/src/pages/session/kya-consent-dialogs.tsx.
// Auto-opens the "Sign in with Skyfire KYA" prompt when a gated tool call on a
// KYA-advertising MCP server returns 401 (server emits mcp.kya.consent.required).
// Confirming mints a token via kyaAuthorize without reconnecting; the agent then
// retries the tool.
export function useKyaConsentDialog() {
  const event = useEvent()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()

  event.on("mcp.kya.consent.required", (evt, metadata) => {
    // Don't stack on top of an open dialog; the agent's next gated retry will
    // re-emit the event if the user dismisses this one.
    if (dialog.stack.length > 0) return

    const name = evt.properties.name
    // Title-case the merchant key for display, preserving separators and any
    // uppercase the server key already carries: "xyz-clothiers" -> "Xyz-Clothiers".
    const merchant = name.replace(/(^|[-_\s])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase())

    void DialogConfirm.show(
      dialog,
      `Sign in with Skyfire KYA — ${merchant}`,
      `Authorize a Skyfire KYA token for ${merchant}?`,
    ).then(async (ok) => {
      // The X, Esc, or Cancel mints nothing.
      if (ok !== true) return
      try {
        const res = await sdk.client.mcp.kyaAuthorize({ name, workspace: metadata.workspace, consentGiven: "true" })
        // Minting can fail as a `failed` status rather than a thrown error
        // (e.g. issuer not enabled); kyaAuthorize returns false in that case.
        if (res.data !== true) {
          const status = await sdk.client.mcp.status({ workspace: metadata.workspace })
          const entry = status.data?.[name]
          const reason = entry && "error" in entry ? entry.error : undefined
          toast.show({
            message: reason ?? `Failed to authorize ${merchant}`,
            variant: "error",
            duration: 5000,
          })
        }
      } catch (error) {
        toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
      }
    })
  })
}
