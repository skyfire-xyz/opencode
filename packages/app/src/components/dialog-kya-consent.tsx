import { Component } from "solid-js"
import { useMutation, useQueryClient } from "@tanstack/solid-query"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useQueryOptions } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"

// Consent gate for "Sign in with Skyfire KYA". The server has been detected as
// supporting the Skyfire KYA grant profile (status needs_kya_consent); confirming
// runs the backend mint + token exchange (confirmKya). Cancelling — the X, Esc, or
// click-away provided by the dialog shell — does nothing, so no token is minted.
export const DialogKyaConsent: Component<{ name: string }> = (props) => {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const language = useLanguage()
  const queryClient = useQueryClient()
  const queryOptions = useQueryOptions()

  const confirm = useMutation(() => ({
    mutationFn: () => sdk.client.mcp.kya.confirm({ name: props.name }),
    onSuccess: async () => {
      dialog.close()
      await queryClient.refetchQueries(queryOptions.mcp(pathKey(sync.directory)))
    },
    onError: (err) => {
      dialog.close()
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    },
  }))

  return (
    <Dialog title={language.t("dialog.kyaConsent.title")} size="normal">
      <div class="flex flex-col gap-4">
        <p class="text-14-regular text-text-weak">{language.t("dialog.kyaConsent.body", { name: props.name })}</p>
        <div class="flex justify-end">
          <Button variant="primary" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
            {language.t("dialog.kyaConsent.confirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
