import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { errorMessage } from "@/util/error"
import { titleCase } from "../../util/title-case"

export function usePayConsentDialog() {
  const event = useEvent()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()

  event.on("mcp.pay.consent.required", (evt, metadata) => {
    if (dialog.stack.length > 0) return

    const p = evt.properties
    const merchant = titleCase(p.name)

    void DialogConfirm.show(dialog, `Approve payment to ${merchant}?`, "", "Cancel").then(async (ok) => {
      // Esc / click-away (undefined) does nothing — the prompt times out
      // server-side and declines. Confirm approves; Cancel declines immediately.
      if (ok === undefined) return
      try {
        const res = await sdk.client.mcp.payConsent({
          name: p.name,
          consentId: p.consentId,
          approved: ok ? "true" : "false",
          workspace: metadata.workspace,
        })
        if (res.data !== true) {
          toast.show({ message: "Payment prompt already resolved or expired.", variant: "warning", duration: 5000 })
        }
      } catch (error) {
        toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
      }
    })
  })
}
