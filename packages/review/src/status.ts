export * as ReviewStatus from "./status.js"

import { ReviewDuration } from "./duration.js"
import { ReviewNotify } from "./notify.js"
import type { ReviewRpc } from "./rpc.js"

/** Exact commands the hints suggest. The plugin never changes service config itself. */
export const LAN_COMMAND = "opencode service set hostname 0.0.0.0"
export const REMOTE_COMMAND = "opencode service set remote true"
export const webhookCommand = (name: string) => `opencode service set env ${name} <webhook-url>`

/** What the server layer reports about itself; undefined when no server layer runs (a test host). */
export interface Server {
  readonly urls: ReadonlyArray<string>
  /** Webhook env vars that are set in the server process. */
  readonly channels: ReadonlyArray<string>
}

export interface Addresses {
  /** False when no server layer reported its URLs, so reachability is unknown rather than missing. */
  readonly known: boolean
  /** A non-loopback http address, reachable from the same network. */
  readonly lan?: string
  /** The OpenTunnel route: the only https URL the server reports. */
  readonly public?: string
}

const loopback = (host: string) =>
  host === "" || host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1"

export function addresses(server: Server | undefined): Addresses {
  if (!server) return { known: false }
  const clean = server.urls.map((url) => url.replace(/\/+$/, ""))
  const remote = clean.find((url) => url.startsWith("https://"))
  const lan = clean.find((url) => url.startsWith("http://") && !loopback(URL.parse(url)?.hostname ?? ""))
  return { known: true, ...(lan ? { lan } : {}), ...(remote ? { public: remote } : {}) }
}

export const reachable = (value: Addresses) => !value.known || value.lan !== undefined || value.public !== undefined

export interface Hint {
  readonly level: "warning" | "info"
  readonly message: string
}

/** Channels the notifier can send to, from the server process environment. */
export function channels(env: { readonly [key: string]: string | undefined }) {
  return [ReviewNotify.FEISHU_ENV, ReviewNotify.WECOM_ENV].filter((name) => (env[name] ?? "").trim() !== "")
}

/** What the user has to set up before a phone can open a review link. Never acted on automatically. */
export function hints(server: Server | undefined): Hint[] {
  if (!server) return []
  const value = addresses(server)
  const result: Hint[] = []
  if (value.lan === undefined && value.public === undefined)
    result.push({
      level: "warning",
      message: [
        "No address a phone can open: the server only listens on loopback.",
        `Same network: ${LAN_COMMAND}`,
        `Anywhere (OpenTunnel): ${REMOTE_COMMAND}`,
        "Both restart the background service.",
      ].join("\n"),
    })
  else if (value.public === undefined)
    result.push({
      level: "info",
      message: `Review links use the LAN address ${value.lan}. For a link that works off this network: ${REMOTE_COMMAND}`,
    })
  if (server.channels.length === 0)
    result.push({
      level: "warning",
      message: [
        "No notification webhook is set, so nobody receives the link.",
        webhookCommand(ReviewNotify.FEISHU_ENV),
        webhookCommand(ReviewNotify.WECOM_ENV),
      ].join("\n"),
    })
  return result
}

/** Local wall-clock `HH:MM`, which is what someone at the terminal reads. */
const clock = (epoch: number) => {
  const date = new Date(epoch)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

/** The one-line headline: mode, idle time, and where links go. */
export function headline(status: ReviewRpc.Status) {
  const mode = status.enabled ? "on" : "off"
  const where = !status.addressesKnown
    ? ""
    : status.public
      ? " · public link"
      : status.lan
        ? " · LAN link"
        : " · no phone address"
  return `Remote review ${mode} · idle ${ReviewDuration.format(status.durationMs)}${where}`
}

/** Status as text lines, shared by the slash command's reply and the TUI. */
export function lines(status: ReviewRpc.Status, now: number) {
  const result = [headline(status)]
  if (status.timerAt !== null)
    result.push(
      `This session: link in ${ReviewDuration.format(Math.max(0, status.timerAt - now))} (${clock(status.timerAt)})`,
    )
  if (status.reviewUntil !== null) result.push(`This session: link open until ${clock(status.reviewUntil)}`)
  if (status.pending > 0) result.push(`Open review links: ${status.pending}`)
  for (const hint of status.hints) result.push(hint.message)
  return result
}
