import { Component } from "solid-js"
import { useMutation } from "@tanstack/solid-query"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"

export const DialogPayConsent: Component<{
  name: string
  consentId: string
}> = (props) => {
  const sdk = useSDK()
  const dialog = useDialog()
  const language = useLanguage()

  const resolve = useMutation(() => ({
    mutationFn: (approved: boolean) =>
      sdk.client.mcp.payConsent({ name: props.name, consentId: props.consentId, approved: approved ? "true" : "false" }),
    onSuccess: () => dialog.close(),
    onError: (err) => {
      dialog.close()
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    },
  }))

  const merchantName = () => props.name.replace(/(^|[-_\s])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase())

  return (
    <Dialog title={language.t("dialog.payConsent.title", { name: merchantName() })} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <p class="text-sm opacity-70">{language.t("dialog.payConsent.description")}</p>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => resolve.mutate(false)} disabled={resolve.isPending}>
            {language.t("dialog.payConsent.no")}
          </Button>
          <Button variant="primary" size="large" onClick={() => resolve.mutate(true)} disabled={resolve.isPending}>
            {language.t("dialog.payConsent.yes")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
