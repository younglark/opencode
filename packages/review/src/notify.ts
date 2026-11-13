export * as ReviewNotify from "./notify.js"

import type { ReviewBridge } from "./bridge.js"

export const FEISHU_ENV = "OPENCODE_REVIEW_FEISHU_WEBHOOK"
export const WECOM_ENV = "OPENCODE_REVIEW_WECOM_WEBHOOK"
/** Sessions finishing within this window share one message. */
export const MERGE_WINDOW = 5_000
const SUMMARY_LIMIT = 300

export interface Item extends ReviewBridge.Ready {
  readonly url: string
}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}>

export function reviewPath(reviewID: string, token: string) {
  return `/api/review/${encodeURIComponent(reviewID)}?t=${encodeURIComponent(token)}`
}

/**
 * Picks the address a phone can open: the OpenTunnel route (the only https URL the server reports) first, then a
 * LAN address, then loopback as a last resort.
 */
export function baseURL(urls: ReadonlyArray<string>) {
  const clean = urls.map((url) => url.replace(/\/+$/, ""))
  const remote = clean.find((url) => url.startsWith("https://"))
  if (remote) return remote
  const lan = clean.find((url) => {
    const host = URL.parse(url)?.hostname ?? ""
    return host !== "" && host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]" && host !== "::1"
  })
  return lan ?? clean[0]
}

function title(items: ReadonlyArray<Item>) {
  return items.length === 1 ? `opencode 等待审查：${items[0].title}` : `opencode：${items.length} 个会话等待审查`
}

function clip(text: string, limit = SUMMARY_LIMIT) {
  const line = text.trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

function project(directory: string) {
  return directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory
}

/** Feishu custom bot, rich-text `post`. */
export function feishu(items: ReadonlyArray<Item>) {
  return {
    msg_type: "post",
    content: {
      post: {
        zh_cn: {
          title: title(items),
          content: items.flatMap((item, index) => [
            [
              {
                tag: "text",
                text: `${items.length > 1 ? `${index + 1}. ` : ""}【${project(item.directory)}】${item.title}`,
              },
            ],
            [{ tag: "text", text: clip(item.summary) }],
            [{ tag: "a", text: "打开审查页", href: item.url }],
          ]),
        },
      },
    },
  }
}

/** WeCom group bot, markdown. */
export function wecom(items: ReadonlyArray<Item>) {
  const lines = [`**${title(items)}**`]
  items.forEach((item, index) => {
    lines.push(
      "",
      `${items.length > 1 ? `${index + 1}. ` : ""}<font color="info">${project(item.directory)}</font> ${item.title}`,
      `> ${clip(item.summary).replace(/\n+/g, " ")}`,
      `[打开审查页](${item.url})`,
    )
  })
  return { msgtype: "markdown", markdown: { content: lines.join("\n") } }
}

export interface Options {
  readonly env: { readonly [key: string]: string | undefined }
  readonly urls: () => ReadonlyArray<string>
  readonly fetch: Fetch
  readonly windowMs?: number
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly log?: (message: string, details?: Record<string, unknown>) => void
}

/** Collects reviews for a short window and sends one merged message per configured webhook. */
export function make(options: Options) {
  const pending: Item[] = []
  const window = options.windowMs ?? MERGE_WINDOW
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const log = options.log ?? (() => {})
  let scheduled = false

  const send = async (name: string, url: string | undefined, body: unknown) => {
    if (!url) return
    try {
      const response = await options.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      // Never log the webhook URL: it is the bot's credential.
      if (!response.ok) log(`review ${name} webhook failed`, { status: response.status })
    } catch (error) {
      log(`review ${name} webhook failed`, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const flush = async () => {
    scheduled = false
    const items = pending.splice(0, pending.length)
    if (items.length === 0) return
    const feishuURL = options.env[FEISHU_ENV]
    const wecomURL = options.env[WECOM_ENV]
    if (!feishuURL && !wecomURL) log("review ready but no webhook configured", { count: items.length })
    await Promise.all([send("feishu", feishuURL, feishu(items)), send("wecom", wecomURL, wecom(items))])
  }

  const push = (review: ReviewBridge.Ready) => {
    const base = baseURL(options.urls())
    if (!base) return log("review ready but the server has no URL yet", { reviewID: review.reviewID })
    // One review per session in a batch: a later trigger for the same session replaces the earlier link.
    const existing = pending.findIndex((item) => item.sessionID === review.sessionID)
    const item = { ...review, url: base + reviewPath(review.reviewID, review.token) }
    if (existing === -1) pending.push(item)
    else pending[existing] = item
    if (scheduled) return
    scheduled = true
    setTimer(() => void flush(), window)
  }

  return { push, flush, pending: () => pending.length }
}
