import { describe, expect, test } from "bun:test"
import { ReviewBridge } from "../src/bridge.js"
import { ReviewNotify } from "../src/notify.js"

const ready = (n: number): ReviewBridge.Ready => ({
  reviewID: `r${n}`,
  token: `tok${n}`,
  sessionID: `s${n}`,
  title: `Session ${n}`,
  summary: `Summary ${n}`,
  directory: `/home/me/project${n}`,
})

const FEISHU = "https://open.feishu.cn/open-apis/bot/v2/hook/secret-feishu"
const WECOM = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-wecom"

function setup(options: { env?: Record<string, string | undefined>; urls?: string[]; status?: number } = {}) {
  const calls: { url: string; body: any }[] = []
  const logs: string[] = []
  const timers: (() => void)[] = []
  const notifier = ReviewNotify.make({
    env: options.env ?? { [ReviewNotify.FEISHU_ENV]: FEISHU, [ReviewNotify.WECOM_ENV]: WECOM },
    urls: () => options.urls ?? ["http://127.0.0.1:4096", "http://192.168.1.5:4096", "https://abc.tunnel.example"],
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { ok: (options.status ?? 200) < 400, status: options.status ?? 200, text: async () => "" }
    },
    setTimer: (callback) => timers.push(callback),
    log: (message, details) => logs.push(`${message} ${JSON.stringify(details ?? {})}`),
  })
  return { notifier, calls, logs, timers }
}

describe("link building", () => {
  test("prefers the OpenTunnel https route, then LAN, then loopback", () => {
    expect(ReviewNotify.baseURL(["http://127.0.0.1:4096", "http://10.0.0.2:4096", "https://x.tunnel.dev/"])).toBe(
      "https://x.tunnel.dev",
    )
    expect(ReviewNotify.baseURL(["http://127.0.0.1:4096", "http://10.0.0.2:4096"])).toBe("http://10.0.0.2:4096")
    expect(ReviewNotify.baseURL(["http://127.0.0.1:4096"])).toBe("http://127.0.0.1:4096")
    expect(ReviewNotify.baseURL([])).toBeUndefined()
    expect(ReviewNotify.reviewPath("a b", "t/=")).toBe("/api/review/a%20b?t=t%2F%3D")
  })
})

describe("notifier", () => {
  test("merges reviews that become ready together into one message per webhook", async () => {
    const { notifier, calls, timers } = setup()
    notifier.push(ready(1))
    notifier.push(ready(2))
    notifier.push(ready(3))
    expect(timers).toHaveLength(1)
    expect(calls).toHaveLength(0)
    await notifier.flush()
    expect(calls.map((call) => call.url).sort()).toEqual([FEISHU, WECOM].sort())
    const feishu = calls.find((call) => call.url === FEISHU)!.body
    expect(feishu.msg_type).toBe("post")
    expect(feishu.content.post.zh_cn.title).toBe("opencode：3 个会话等待审查")
    const links = feishu.content.post.zh_cn.content.flat().filter((node: any) => node.tag === "a")
    expect(links.map((node: any) => node.href)).toEqual([
      "https://abc.tunnel.example/api/review/r1?t=tok1",
      "https://abc.tunnel.example/api/review/r2?t=tok2",
      "https://abc.tunnel.example/api/review/r3?t=tok3",
    ])
    const wecom = calls.find((call) => call.url === WECOM)!.body
    expect(wecom.msgtype).toBe("markdown")
    expect(wecom.markdown.content).toContain("**opencode：3 个会话等待审查**")
    expect(wecom.markdown.content).toContain("[打开审查页](https://abc.tunnel.example/api/review/r2?t=tok2)")
    expect(wecom.markdown.content).toContain("project3")
  })

  test("a single review gets its own title, and a later link for the same session replaces the earlier one", async () => {
    const { notifier, calls } = setup({ env: { [ReviewNotify.FEISHU_ENV]: FEISHU } })
    notifier.push(ready(1))
    notifier.push({ ...ready(1), reviewID: "r1b", token: "tok1b" })
    await notifier.flush()
    expect(calls).toHaveLength(1)
    const body = calls[0].body
    expect(body.content.post.zh_cn.title).toBe("opencode 等待审查：Session 1")
    expect(JSON.stringify(body)).toContain("r1b?t=tok1b")
    expect(JSON.stringify(body)).not.toContain('r1?t=tok1"')
  })

  test("never logs webhook URLs on failure, and reports a missing configuration", async () => {
    const failing = setup({ status: 500 })
    failing.notifier.push(ready(1))
    await failing.notifier.flush()
    expect(failing.logs.length).toBe(2)
    expect(failing.logs.join("\n")).not.toContain("secret")

    const unconfigured = setup({ env: {} })
    unconfigured.notifier.push(ready(1))
    await unconfigured.notifier.flush()
    expect(unconfigured.calls).toHaveLength(0)
    expect(unconfigured.logs[0]).toContain("no webhook configured")
  })
})

describe("bridge", () => {
  test("publishes to the registered publisher and unregisters only itself", () => {
    const seen: string[] = []
    const off = ReviewBridge.register((review) => seen.push(review.reviewID))
    expect(ReviewBridge.publish(ready(1))).toBe(true)
    const offOther = ReviewBridge.register((review) => seen.push(`other:${review.reviewID}`))
    off()
    expect(ReviewBridge.publish(ready(2))).toBe(true)
    offOther()
    expect(ReviewBridge.publish(ready(3))).toBe(false)
    expect(seen).toEqual(["r1", "other:r2"])
  })
})
