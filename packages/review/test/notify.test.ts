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

const PUSHPLUS_TOKEN = "secret-pushplus-token"
const SCT_KEY = "SCTsecretkey123"
const SC3_KEY = "sctp4567tsecretkey"

type Reply = { status?: number; text?: string; throws?: string }

function setup(
  options: {
    env?: Record<string, string | undefined>
    urls?: string[]
    status?: number
    reply?: (url: string) => Reply
  } = {},
) {
  const calls: { url: string; body: any }[] = []
  const logs: string[] = []
  const timers: (() => void)[] = []
  const notifier = ReviewNotify.make({
    env: options.env ?? { [ReviewNotify.FEISHU_ENV]: FEISHU, [ReviewNotify.WECOM_ENV]: WECOM },
    urls: () => options.urls ?? ["http://127.0.0.1:4096", "http://192.168.1.5:4096", "https://abc.tunnel.example"],
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      const reply = options.reply?.(url) ?? { status: options.status }
      if (reply.throws) throw new Error(reply.throws)
      const status = reply.status ?? 200
      return { ok: status < 400, status, text: async () => reply.text ?? "" }
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
    expect(links.map((node: any) => [node.text, node.href])).toEqual([
      ["外网", "https://abc.tunnel.example/api/review/r1?t=tok1"],
      ["局域网", "http://192.168.1.5:4096/api/review/r1?t=tok1"],
      ["外网", "https://abc.tunnel.example/api/review/r2?t=tok2"],
      ["局域网", "http://192.168.1.5:4096/api/review/r2?t=tok2"],
      ["外网", "https://abc.tunnel.example/api/review/r3?t=tok3"],
      ["局域网", "http://192.168.1.5:4096/api/review/r3?t=tok3"],
    ])
    const wecom = calls.find((call) => call.url === WECOM)!.body
    expect(wecom.msgtype).toBe("markdown")
    expect(wecom.markdown.content).toContain("**opencode：3 个会话等待审查**")
    expect(wecom.markdown.content).toContain("[外网](https://abc.tunnel.example/api/review/r2?t=tok2)")
    expect(wecom.markdown.content).toContain("[局域网](http://192.168.1.5:4096/api/review/r2?t=tok2)")
    expect(wecom.markdown.content).toContain("project3")
  })

  test("Feishu and WeCom send only the one available link when there is no pair", async () => {
    const { notifier, calls } = setup({ urls: ["http://127.0.0.1:4096", "http://192.168.1.5:4096"] })
    notifier.push(ready(1))
    await notifier.flush()
    const feishu = calls.find((call) => call.url === FEISHU)!.body
    const links = feishu.content.post.zh_cn.content.flat().filter((node: any) => node.tag === "a")
    expect(links.map((node: any) => [node.text, node.href])).toEqual([
      ["打开审查页", "http://192.168.1.5:4096/api/review/r1?t=tok1"],
    ])
    const wecom = calls.find((call) => call.url === WECOM)!.body
    expect(wecom.markdown.content).toContain("[打开审查页](http://192.168.1.5:4096/api/review/r1?t=tok1)")
    expect(wecom.markdown.content).not.toContain("外网")
    expect(wecom.markdown.content).not.toContain("局域网")
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

describe("wechat channels", () => {
  const okReply = (url: string): Reply =>
    url === ReviewNotify.PUSHPLUS_URL ? { text: '{"code":200,"msg":"请求成功","data":"abc"}' } : { text: '{"code":0}' }

  test("PushPlus posts token, title, html content with public and LAN links", async () => {
    const { notifier, calls, logs } = setup({ env: { [ReviewNotify.PUSHPLUS_ENV]: PUSHPLUS_TOKEN }, reply: okReply })
    notifier.push(ready(1))
    notifier.push(ready(2))
    await notifier.flush()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://www.pushplus.plus/send")
    const body = calls[0].body
    expect(body.token).toBe(PUSHPLUS_TOKEN)
    expect(body.template).toBe("html")
    expect(body.title).toBe("opencode：2 个会话等待审查")
    expect(body.content).toContain('<a href="https://abc.tunnel.example/api/review/r1?t=tok1">打开审查页</a>')
    expect(body.content).toContain('<a href="http://192.168.1.5:4096/api/review/r2?t=tok2">局域网链接</a>')
    expect(body.content).toContain("Summary 2")
    expect(body.content).toContain("【project1】Session 1")
    expect(logs).toEqual([])
  })

  test("PushPlus escapes html in titles and summaries", () => {
    const body = ReviewNotify.pushplus("t", [
      { ...ready(1), title: "<b>x</b>", summary: 'a & "b"', url: "https://x/api/review/r?t=a&b" },
    ])
    expect(body.content).toContain("&#60;b&#62;x&#60;/b&#62;")
    expect(body.content).toContain("a &#38; &#34;b&#34;")
    expect(body.content).toContain('href="https://x/api/review/r?t=a&#38;b"')
  })

  test("Server酱 Turbo key posts title, short with the link, and markdown desp", async () => {
    const { notifier, calls, logs } = setup({ env: { [ReviewNotify.SERVERCHAN_ENV]: SCT_KEY }, reply: okReply })
    notifier.push(ready(1))
    await notifier.flush()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`https://sctapi.ftqq.com/${SCT_KEY}.send`)
    const body = calls[0].body
    expect(body.title).toBe("opencode 等待审查：Session 1")
    expect(body.title).not.toContain("\n")
    expect(body.short).toBe("Session 1 https://abc.tunnel.example/api/review/r1?t=tok1")
    expect(body.desp).toContain("[打开审查页](https://abc.tunnel.example/api/review/r1?t=tok1)")
    expect(body.desp).toContain("[局域网链接](http://192.168.1.5:4096/api/review/r1?t=tok1)")
    expect(body.desp).toContain("Summary 1")
    expect(logs).toEqual([])
  })

  test("Server酱 merged message keeps a short, single-line title and the first link in short", () => {
    const items = [1, 2, 3].map((n) => ({ ...ready(n), url: `https://x/r${n}` }))
    const body = ReviewNotify.serverchan(items)
    expect(body.title).toBe("opencode：3 个会话等待审查")
    expect(body.short).toBe("3 个会话 · https://x/r1")
    expect(body.desp).toContain("### 3. 【project3】Session 3")
    const long = ReviewNotify.serverchan([{ ...ready(1), title: "x".repeat(80) + "\nmore", url: "https://x/r" }])
    expect(long.title.length).toBeLessThanOrEqual(32)
    expect(long.title).not.toContain("\n")
  })

  test("Server酱³ sctp keys use the uid endpoint; malformed sctp keys are skipped", async () => {
    expect(ReviewNotify.serverchanURL(SC3_KEY)).toBe(`https://4567.push.ft07.com/send/${SC3_KEY}.send`)
    expect(ReviewNotify.serverchanURL("SCT1")).toBe("https://sctapi.ftqq.com/SCT1.send")
    expect(ReviewNotify.serverchanURL("sctpbroken")).toBeUndefined()

    const malformed = setup({ env: { [ReviewNotify.SERVERCHAN_ENV]: "sctpbroken" } })
    malformed.notifier.push(ready(1))
    await malformed.notifier.flush()
    expect(malformed.calls).toHaveLength(0)
    expect(malformed.logs.join("\n")).toContain("malformed")
    expect(malformed.logs.join("\n")).not.toContain("sctpbroken")
  })

  test("logs JSON error codes, HTTP failures and network errors without the token or key", async () => {
    const env = { [ReviewNotify.PUSHPLUS_ENV]: PUSHPLUS_TOKEN, [ReviewNotify.SERVERCHAN_ENV]: SCT_KEY }
    const coded = setup({
      env,
      reply: (url) =>
        url === ReviewNotify.PUSHPLUS_URL
          ? { text: '{"code":903,"msg":"无效的用户token"}' }
          : { text: '{"code":40001}' },
    })
    coded.notifier.push(ready(1))
    await coded.notifier.flush()
    expect(coded.calls).toHaveLength(2)
    expect(coded.logs).toHaveLength(2)
    expect(coded.logs.find((line) => line.includes("pushplus"))).toContain('"code":903')
    expect(coded.logs.find((line) => line.includes("serverchan"))).toContain('"code":40001')

    const broken = setup({
      env,
      reply: (url) => (url === ReviewNotify.PUSHPLUS_URL ? { status: 502 } : { throws: "connect ECONNREFUSED" }),
    })
    broken.notifier.push(ready(1))
    await broken.notifier.flush()
    expect(broken.logs).toHaveLength(2)
    expect(broken.logs.join("\n")).toContain('"status":502')
    expect(broken.logs.join("\n")).toContain("ECONNREFUSED")

    const garbled = setup({ env, reply: () => ({ text: "<html>oops</html>" }) })
    garbled.notifier.push(ready(1))
    await garbled.notifier.flush()
    expect(garbled.logs).toHaveLength(2)

    for (const logs of [coded.logs, broken.logs, garbled.logs]) {
      expect(logs.join("\n")).not.toContain("secret")
      expect(logs.join("\n")).not.toContain(SCT_KEY)
    }
  })

  test("a LAN-only server sends just the LAN link", async () => {
    const { notifier, calls } = setup({
      env: { [ReviewNotify.SERVERCHAN_ENV]: SCT_KEY },
      urls: ["http://127.0.0.1:4096", "http://192.168.1.5:4096"],
      reply: okReply,
    })
    notifier.push(ready(1))
    await notifier.flush()
    expect(calls[0].body.desp).toContain("[打开审查页](http://192.168.1.5:4096/api/review/r1?t=tok1)")
    expect(calls[0].body.desp).not.toContain("局域网链接")
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
