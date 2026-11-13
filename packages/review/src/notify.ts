export * as ReviewNotify from "./notify.js"

import type { ReviewBridge } from "./bridge.js"

export const FEISHU_ENV = "OPENCODE_REVIEW_FEISHU_WEBHOOK"
export const WECOM_ENV = "OPENCODE_REVIEW_WECOM_WEBHOOK"
/** PushPlus user/message token (https://www.pushplus.plus/doc/guide/api.html), delivers to personal WeChat. */
export const PUSHPLUS_ENV = "OPENCODE_REVIEW_PUSHPLUS_TOKEN"
/** Server酱 SendKey: `SCT…` (Turbo, WeChat) or `sctp{uid}t…` (Server酱³ app). */
export const SERVERCHAN_ENV = "OPENCODE_REVIEW_SERVERCHAN_KEY"
export const PUSHPLUS_URL = "https://www.pushplus.plus/send"
/** Sessions finishing within this window share one message. */
export const MERGE_WINDOW = 5_000
const SUMMARY_LIMIT = 300

export interface Item extends ReviewBridge.Ready {
  /** The link a phone should open first (OpenTunnel when available). */
  readonly url: string
  /** The same review on the LAN address, when the primary link is the public one. */
  readonly lan?: string
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

/** A non-loopback http address, used as the second link next to the public one. */
function lanURL(urls: ReadonlyArray<string>) {
  return urls
    .map((url) => url.replace(/\/+$/, ""))
    .find((url) => {
      if (!url.startsWith("http://")) return false
      const host = URL.parse(url)?.hostname ?? ""
      return host !== "" && host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]" && host !== "::1"
    })
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

/**
 * The links a channel should show: when both a public and a LAN address exist they are labeled 外网 and 局域网,
 * and they share the same token. A server with only one usable address sends that one, unlabeled.
 */
export function links(item: Item): ReadonlyArray<{ readonly text: string; readonly href: string }> {
  if (item.lan)
    return [
      { text: "外网", href: item.url },
      { text: "局域网", href: item.lan },
    ]
  return [{ text: "打开审查页", href: item.url }]
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
            ...links(item).map((link) => [{ tag: "a", text: link.text, href: link.href }]),
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
      links(item)
        .map((link) => `[${link.text}](${link.href})`)
        .join(" · "),
    )
  })
  return { msgtype: "markdown", markdown: { content: lines.join("\n") } }
}

function escape(text: string) {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

/** PushPlus `/send` body, html template (the default), rendered in the WeChat official account article. */
export function pushplus(token: string, items: ReadonlyArray<Item>) {
  const blocks = items.map((item, index) => {
    const links = [`<a href="${escape(item.url)}">打开审查页</a>`]
    if (item.lan) links.push(`<a href="${escape(item.lan)}">局域网链接</a>`)
    return [
      `<p><b>${items.length > 1 ? `${index + 1}. ` : ""}【${escape(project(item.directory))}】${escape(item.title)}</b></p>`,
      `<p>${escape(clip(item.summary)).replace(/\n+/g, "<br>")}</p>`,
      `<p>${links.join(" · ")}</p>`,
      `<p style="color:#888;word-break:break-all">${escape(item.url)}</p>`,
    ].join("")
  })
  return { token, title: title(items), content: blocks.join("<hr>"), template: "html" }
}

/** Server酱 API endpoint for a SendKey; `sctp{uid}t…` keys go to Server酱³. Undefined for a malformed sctp key. */
export function serverchanURL(key: string) {
  if (key.startsWith("sctp")) {
    const uid = /^sctp(\d+)t/.exec(key)?.[1]
    return uid ? `https://${uid}.push.ft07.com/send/${encodeURIComponent(key)}.send` : undefined
  }
  return `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`
}

/**
 * Server酱 body. WeChat often shows only the card (`title` + `short`), so the first link goes into `short`;
 * `title` must not contain newlines and is kept short.
 */
export function serverchan(items: ReadonlyArray<Item>) {
  const lines: string[] = []
  items.forEach((item, index) => {
    lines.push(
      `### ${items.length > 1 ? `${index + 1}. ` : ""}【${project(item.directory)}】${item.title}`,
      "",
      clip(item.summary).replace(/\n+/g, " "),
      "",
      `[打开审查页](${item.url})${item.lan ? ` · [局域网链接](${item.lan})` : ""}`,
      "",
    )
  })
  const first = items[0]
  const short = items.length === 1 ? `${clip(first.title, 40)} ${first.url}` : `${items.length} 个会话 · ${first.url}`
  return { title: clip(title(items).replace(/\s+/g, " "), 32), desp: lines.join("\n").trim(), short }
}

/** Returns an error description when a 2xx reply still reports failure in its JSON `code`. */
const codeCheck = (expected: number) => (text: string) => {
  try {
    const reply = JSON.parse(text) as { code?: unknown }
    return reply.code === expected ? undefined : { code: reply.code }
  } catch {
    return { code: "unparsable reply" }
  }
}

export interface Options {
  readonly env: { readonly [key: string]: string | undefined }
  readonly urls: () => ReadonlyArray<string>
  readonly fetch: Fetch
  readonly windowMs?: number
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly log?: (message: string, details?: Record<string, unknown>) => void
}

/** Collects reviews for a short window and sends one merged message per configured channel. */
export function make(options: Options) {
  const pending: Item[] = []
  const window = options.windowMs ?? MERGE_WINDOW
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const log = options.log ?? (() => {})
  let scheduled = false

  const send = async (
    name: string,
    url: string | undefined,
    body: unknown,
    check?: (text: string) => Record<string, unknown> | undefined,
  ) => {
    if (!url) return
    try {
      const response = await options.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      // Never log the webhook URL, token or key: they are the channel's credential.
      if (!response.ok) return log(`review ${name} webhook failed`, { status: response.status })
      const failure = check?.(await response.text())
      if (failure) log(`review ${name} webhook failed`, failure)
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
    const pushplusToken = options.env[PUSHPLUS_ENV]?.trim()
    const serverchanKey = options.env[SERVERCHAN_ENV]?.trim()
    const serverchanEndpoint = serverchanKey ? serverchanURL(serverchanKey) : undefined
    if (serverchanKey && !serverchanEndpoint) log(`review serverchan key is malformed`, { env: SERVERCHAN_ENV })
    if (!feishuURL && !wecomURL && !pushplusToken && !serverchanKey)
      log("review ready but no webhook configured", { count: items.length })
    await Promise.all([
      send("feishu", feishuURL, feishu(items)),
      send("wecom", wecomURL, wecom(items)),
      send("pushplus", pushplusToken ? PUSHPLUS_URL : undefined, pushplus(pushplusToken ?? "", items), codeCheck(200)),
      send("serverchan", serverchanEndpoint, serverchan(items), codeCheck(0)),
    ])
  }

  const push = (review: ReviewBridge.Ready) => {
    const base = baseURL(options.urls())
    if (!base) return log("review ready but the server has no URL yet", { reviewID: review.reviewID })
    // One review per session in a batch: a later trigger for the same session replaces the earlier link.
    const existing = pending.findIndex((item) => item.sessionID === review.sessionID)
    const path = reviewPath(review.reviewID, review.token)
    const lan = base.startsWith("https://") ? lanURL(options.urls()) : undefined
    const item: Item = { ...review, url: base + path, ...(lan ? { lan: lan + path } : {}) }
    if (existing === -1) pending.push(item)
    else pending[existing] = item
    if (scheduled) return
    scheduled = true
    setTimer(() => void flush(), window)
  }

  return { push, flush, pending: () => pending.length }
}
