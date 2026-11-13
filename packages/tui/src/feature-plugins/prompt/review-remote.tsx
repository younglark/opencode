import { Plugin } from "@opencode/plugin/tui"
import { ReviewCommand } from "@opencode/review/command"
import { ReviewDuration } from "@opencode/review/duration"
import { ReviewRpc } from "@opencode/review/rpc"
import { ReviewStatus } from "@opencode/review/status"
import { createSignal, Show } from "solid-js"
import { useTheme } from "../../context/theme"

/**
 * `/review-remote <duration>|on|off|now` and `<leader>v` for `now`. The server plugin owns the mode; this calls its
 * RPC so results show as toasts and status as a dialog instead of a failed command, and shows the mode beside the
 * prompt. Missing LAN/public addresses and notification channels come back as hints with the commands to run: service config is
 * never changed from here.
 */
export const COMMAND = "review.remote"
export const NOW_COMMAND = "review.remote.now"

type Settings = { readonly enabled: boolean; readonly durationMs: number }
type ToastOptions = Parameters<Plugin.Context["ui"]["toast"]["show"]>[0]

/** Toast for a command result: its message, then any setup the user still has to do. */
export function resultToast(result: ReviewRpc.Result): ToastOptions {
  const warning = result.status.hints.find((hint) => hint.level === "warning")
  const extra = result.ok && result.status.enabled ? result.status.hints.map((hint) => hint.message) : []
  return {
    title: result.ok ? ReviewStatus.headline(result.status) : "Remote review",
    message: [result.message, ...extra].join("\n\n"),
    variant: !result.ok ? "error" : warning && result.status.enabled ? "warning" : "success",
    duration: extra.length > 0 ? 10_000 : undefined,
  }
}

/** Status dialog text. */
export function statusMessage(status: ReviewRpc.Status, now: number) {
  return [...ReviewStatus.lines(status, now).slice(1), ReviewCommand.USAGE].join("\n\n")
}

export default Plugin.define({
  id: "opencode.review-remote",
  setup(context) {
    const rpc = context.client.rpc(ReviewRpc.Definition)
    const [settings, setSettings] = createSignal<Settings>()

    const session = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }
    const location = (sessionID: string | undefined) => {
      const directory = sessionID ? context.data.session.get(sessionID)?.location.directory : undefined
      return directory ? { location: { directory } } : undefined
    }
    const fail = (error: unknown) =>
      context.ui.toast.show({
        title: "Remote review",
        message: error instanceof Error ? error.message : String(error),
        variant: "error",
      })

    // Settings are global; any Location's plugin answers. A server without the plugin errors and shows nothing.
    const load = () =>
      void rpc.status({}, location(session())).then(
        (status) => setSettings({ enabled: status.enabled, durationMs: status.durationMs }),
        () => setSettings(undefined),
      )
    const offChanged = rpc.events.on("changed", (event) => void setSettings(event.data))
    const offConnected = context.data.on("server.connected", load)
    load()

    const showStatus = async (sessionID: string | undefined) => {
      const status = await rpc.status(sessionID ? { sessionID } : {}, location(sessionID))
      setSettings({ enabled: status.enabled, durationMs: status.durationMs })
      await context.ui.dialog.alert({
        title: ReviewStatus.headline(status),
        message: statusMessage(status, Date.now()),
      })
    }

    const run = async (text: string) => {
      const sessionID = session()
      const action = text.trim()
      try {
        if (action === "" || action.toLowerCase() === "status") return await showStatus(sessionID)
        if (!sessionID) {
          context.ui.toast.show({ message: "Open a session first", variant: "warning" })
          return
        }
        const result = await rpc.run({ sessionID, text: action }, location(sessionID))
        setSettings({ enabled: result.status.enabled, durationMs: result.status.durationMs })
        context.ui.toast.show(resultToast(result))
      } catch (error) {
        fail(error)
      }
    }

    context.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        const theme = useTheme()
        return (
          <Show when={settings()?.enabled ? settings() : undefined}>
            {(current) => (
              <box flexShrink={0}>
                <text fg={theme.text.muted} wrapMode="none">
                  ⇢ review {ReviewDuration.format(current().durationMs)}
                </text>
              </box>
            )}
          </Show>
        )
      },
    })

    // Layered under the app slot, like /btw, so the leader token is registered before `<leader>v` binds.
    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: COMMAND,
              title: "Remote review",
              description: "Send a phone review link after the session sits idle [<duration>|on|off|now]",
              group: "Session",
              palette: true,
              slash: { name: "review-remote", arguments: true },
              run: (input) => run(input ?? ""),
            },
            {
              id: NOW_COMMAND,
              title: "Send a review link now",
              description: "Same as /review-remote now",
              group: "Session",
              palette: true,
              // ctrl+x v by default; free upstream (`<leader>r` is session.redo).
              bind: "<leader>v",
              run: () => run("now"),
            },
          ],
        }))
        return null
      },
    })

    return () => {
      offChanged()
      offConnected()
    }
  },
})
