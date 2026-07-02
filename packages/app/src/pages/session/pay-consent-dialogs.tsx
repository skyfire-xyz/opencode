import { useSDK } from "@/context/sdk"
import { onCleanup } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context"
import { DialogPayConsent } from "@/components/dialog-pay-consent"

export function usePayConsentDialogs() {
  const sdk = useSDK()
  const dialog = useDialog()

  onCleanup(
    sdk.event.on("mcp.pay.consent.required", (evt) => {
      if (dialog.active) return
      const p = evt.properties
      dialog.show(() => <DialogPayConsent name={p.name} consentId={p.consentId} />)
    }),
  )
}
