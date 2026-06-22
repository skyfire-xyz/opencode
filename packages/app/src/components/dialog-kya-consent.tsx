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
// re-runs connect with kyaConsent=true, which mints + exchanges the token and
// connects. Cancelling — the X, Esc, or click-away provided by the dialog shell —
// does nothing, so no token is minted.
export const DialogKyaConsent: Component<{ name: string }> = (props) => {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const language = useLanguage()
  const queryClient = useQueryClient()
  const queryOptions = useQueryOptions()

  const confirm = useMutation(() => ({
    mutationFn: () => sdk.client.mcp.connect({ name: props.name, kyaConsent: "true" }),
    onSuccess: async () => {
      dialog.close()
      // Post-consent minting can fail (e.g. issuer not enabled) as a `failed` status,
      // not a thrown error. Read the refetched cache directly; sync.data.mcp can lag.
      const opts = queryOptions.mcp(pathKey(sync.directory))
      await queryClient.refetchQueries(opts)
      const status = queryClient.getQueryData<Record<string, { status: string; error?: string }>>(opts.queryKey)?.[
        props.name
      ]
      if (status?.status === "failed") {
        showToast({ variant: "error", title: language.t("common.requestFailed"), description: status.error })
      }
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

  // Capitalize the first letter of each word (split on - _ space) for display,
  // preserving separators and any uppercase the server key already carries — so
  // "xyz-clothiers" → "Xyz-Clothiers" and "XYZ-Clothiers" stays "XYZ-Clothiers".
  const merchantName = () => props.name.replace(/(^|[-_\s])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase())

  return (
    <Dialog title={language.t("dialog.kyaConsent.title", { name: merchantName() })} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()} disabled={confirm.isPending}>
            {language.t("dialog.kyaConsent.no")}
          </Button>
          <Button variant="primary" size="large" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
            {language.t("dialog.kyaConsent.yes")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
