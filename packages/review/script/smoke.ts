/**
 * End-to-end smoke test of the approval page in a real headless Chrome, without the opencode server.
 *
 *   bun packages/review/script/smoke.ts            # desktop (mouse) and phone (touch) runs
 *   CHROME=/path/to/chrome bun packages/review/script/smoke.ts
 *
 * It snapshots an image, a video, a diff and a custom page into a temp dir, serves the review through
 * ReviewHandler on 127.0.0.1, then drives Chrome over the DevTools protocol: draws a box on the image, steps a
 * video frame and draws on it, answers the custom page through its bridge, sets form answers with the keyboard,
 * reloads to check the draft survives, submits with Ctrl+Enter, and checks feedback.json and the written-back
 * prompt. The video is recorded in the browser (canvas + MediaRecorder), so no ffmpeg is needed.
 * Not part of `bun test`: it needs Chrome. Exit code 0 means every check passed.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ReviewAssets } from "../src/assets.js"
import { ReviewHandler } from "../src/handler.js"
import { ReviewState } from "../src/state.js"
import { ReviewToken } from "../src/token.js"
import { memoryStorage } from "../test/fixture.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome"
const failures: string[] = []
const check = (label: string, ok: unknown, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`)
  if (!ok) failures.push(label)
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- minimal DevTools client -------------------------------------------------------------------------------
class Page {
  private id = 0
  logs: string[] = []
  private children: { session: string; url: string }[] = []
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      if (message.method === "Target.attachedToTarget") this.children.push({ session: message.params.sessionId, url: message.params.targetInfo.url })
      if (message.method === "Target.detachedFromTarget") this.children = this.children.filter((c) => c.session !== message.params.sessionId)
      if (message.method === "Page.javascriptDialogOpening") void this.send("Page.handleJavaScriptDialog", { accept: true })
      if (message.method === "Runtime.exceptionThrown") this.logs.push("exception: " + (message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text))
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error")
        this.logs.push("console: " + message.params.args.map((a: any) => a.value ?? a.description).join(" "))
      const waiter = message.id && this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    })
  }
  static async open(port: number) {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)))
    const page = new Page(ws)
    await page.send("Page.enable")
    await page.send("Runtime.enable")
    // Sandboxed (opaque-origin) iframes run out of process; attach to them so evalInFrame can reach them.
    await page.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    return page
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise<any>((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async eval<T = unknown>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value as T
  }
  /** Evaluates inside an out-of-process child frame whose URL contains `part` (sandboxed, opaque-origin frames). */
  async evalInFrame<T = unknown>(part: string, expression: string): Promise<T> {
    // Attach-time URLs can be blank (the frame had not navigated yet), so ask each child where it is now.
    let child: { session: string } | undefined
    for (const c of this.children.toReversed()) {
      const here = await this.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, c.session).catch(() => undefined)
      if (String(here?.result?.value ?? "").includes(part)) { child = c; break }
    }
    if (!child) throw new Error("no frame for " + part)
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, child.session)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value as T
  }
  async until<T>(expression: string, timeout = 15_000): Promise<T> {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const value = await this.eval<T>(expression).catch(() => undefined)
      if (value) return value
      await sleep(100)
    }
    throw new Error("timed out waiting for " + expression)
  }
  async goto(url: string) {
    await this.send("Page.navigate", { url })
    await this.until("document.readyState === 'complete'")
  }
  async key(key: string, options: { code?: string; modifiers?: number; text?: string } = {}) {
    const base = { key, code: options.code ?? key, modifiers: options.modifiers ?? 0 }
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(options.text ? { text: options.text } : {}) })
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
  }
  async drag(touch: boolean, x1: number, y1: number, x2: number, y2: number) {
    const steps = 8
    if (touch) {
      await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x1, y: y1 }] })
      for (let i = 1; i <= steps; i++)
        await this.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps }],
        })
      await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      return
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1 })
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 })
    for (let i = 1; i <= steps; i++)
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: x1 + ((x2 - x1) * i) / steps,
        y: y1 + ((y2 - y1) * i) / steps,
        button: "left",
        buttons: 1,
      })
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 0, clickCount: 1 })
  }
  async tap(touch: boolean, x: number, y: number) {
    if (touch) {
      await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
      await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      return
    }
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 })
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 })
  }
  close() {
    this.ws.close()
  }
}

// ---- fixtures --------------------------------------------------------------------------------------------
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "review-smoke-"))
const work = path.join(temp, "work")
const root = path.join(temp, "root")
await fs.mkdir(path.join(work, "page"), { recursive: true })

const profile = path.join(temp, "chrome")
const chrome = Bun.spawn(
  [CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--mute-audio",
    "--autoplay-policy=no-user-gesture-required", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { stdout: "ignore", stderr: "pipe" },
)
const devtools = await (async () => {
  const reader = chrome.stderr.getReader()
  let text = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) throw new Error("chrome exited: " + text)
    text += new TextDecoder().decode(value)
    const match = text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)
    if (match) return Number(match[1])
  }
})()

let server: ReturnType<typeof Bun.serve> | undefined
try {
  // Image and video come from the browser itself: a canvas PNG and a MediaRecorder WebM, no ffmpeg.
  const maker = await Page.open(devtools)
  const media = await maker.eval<{ png: string; webm: string }>(`(async () => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 240
    const g = c.getContext("2d")
    const paint = (n) => { g.fillStyle = "hsl(" + (n * 37 % 360) + ",60%,45%)"; g.fillRect(0, 0, 320, 240)
      g.fillStyle = "#fff"; g.font = "bold 64px sans-serif"; g.fillText(String(n), 110, 150) }
    paint(0)
    const png = c.toDataURL("image/png").split(",")[1]
    const stream = c.captureStream(10)
    const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" })
    const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.start()
    for (let n = 0; n < 20; n++) { paint(n); stream.getVideoTracks()[0].requestFrame?.(); await new Promise((r) => setTimeout(r, 100)) }
    await new Promise((r) => { rec.onstop = r; rec.stop() })
    const buf = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer())
    let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return { png, webm: btoa(bin) }
  })()`)
  maker.close()
  await fs.writeFile(path.join(work, "shot.png"), Buffer.from(media.png, "base64"))
  await fs.writeFile(path.join(work, "clip.webm"), Buffer.from(media.webm, "base64"))
  check("browser recorded a WebM fixture", media.webm.length > 1000)
  await fs.writeFile(path.join(work, "page", "style.css"), "button{position:fixed;left:0;top:0;width:240px;height:100px;font-size:20px}")
  await fs.writeFile(
    path.join(work, "page", "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>
<button id="pick">选夜景预设</button><p id="restored"></p>
<script>
document.getElementById("pick").onclick = () => {
  opencodeReview.setResult({ preset: "night", volume: 0.8 })
  opencodeReview.setVerdict("fail")
  opencodeReview.setText("夜景太暗")
}
addEventListener("opencode-review:hello", (e) => {
  document.getElementById("restored").textContent = JSON.stringify(e.detail.draft || {})
})
</script></body></html>`,
  )

  async function scenario(mobile: boolean) {
    const label = mobile ? "phone" : "desktop"
    const bundle = "smoke" + (mobile ? "m" : "d")
    const items = await run(
      ReviewAssets.snapshot({
        root,
        directory: work,
        bundle,
        items: [
          { id: "shot", kind: "image", title: "截图", feedback: { annotate: true, form: [{ id: "verdict", type: "choice", label: "结论", required: true, options: [{ id: "pass", label: "通过" }, { id: "fail", label: "不通过" }] }] }, assets: [{ id: "s", path: "shot.png" }] },
          { id: "clip", kind: "video", title: "动画", feedback: { annotate: true, form: [{ id: "verdict", type: "choice", label: "结论", required: true, options: [{ id: "pass", label: "通过" }, { id: "fail", label: "不通过" }] }] }, assets: [{ id: "c", path: "clip.webm", fps: 10 }] },
          { id: "diff", kind: "diff", title: "代码改动", feedback: { form: [{ id: "verdict", type: "choice", label: "结论", required: true, options: [{ id: "pass", label: "通过" }, { id: "fail", label: "不通过" }] }] }, diff: { source: "session" } },
          { id: "ui", kind: "custom", title: "设置页", custom: { entry: "page/index.html", files: ["style.css"] } },
        ],
      }),
    )
    const token = ReviewToken.generate()
    const storage = memoryStorage()
    storage.map.set(ReviewState.REVIEW_PREFIX + bundle, {
      id: bundle, sessionID: "s1", directory: work, title: "Smoke " + label, summary: "冒烟测试",
      tokenHash: ReviewToken.hash(token), marker: 100, createdAt: Date.now(), expiresAt: Date.now() + ReviewState.DEFAULT_TTL,
      status: "open", origin: "agent", request: { items, wait: { mode: "async" } },
    })
    storage.map.set(ReviewState.OPEN_PREFIX + "s1", [bundle])
    const prompts: { text: string; files?: ReadonlyArray<{ name: string }> }[] = []
    const handler = ReviewHandler.make({
      storage, root, now: Effect.sync(() => Date.now()),
      session: () => Effect.succeed({ busy: 1, idle: 2 }),
      diff: () => Effect.succeed([{ file: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, status: "modified" }]),
      prompt: (input) => Effect.sync(() => void prompts.push(input)),
    })
    server?.stop(true)
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const parts = url.pathname.split("/").filter(Boolean) // api review :id ...
        const id = decodeURIComponent(parts[2] ?? "")
        const html = (page: ReviewHandler.Response) =>
          new Response(page.html, { status: page.status, headers: { "content-type": "text/html; charset=utf-8" } })
        if (parts.length === 3 && request.method === "GET") return html(await run(handler.view(id, url.searchParams.get("t") ?? "")))
        if (parts[3] === "annotator") return html(await run(handler.annotator(id, url.searchParams.get("t"))))
        if (parts[3] === "submit" && request.method === "POST") {
          const body = await request.json()
          const answer = await run(handler.submitJSON(id, body))
          return Response.json(answer.body, { status: answer.status })
        }
        if (parts[3] === "a") {
          const asset = await run(handler.asset({
            reviewID: id, token: decodeURIComponent(parts[4]), item: decodeURIComponent(parts[5]),
            file: parts.slice(6).map(decodeURIComponent).join("/"), range: request.headers.get("range"),
          }))
          if (asset.type === "error") return new Response(null, { status: asset.status })
          const body = asset.bytes ?? Bun.file(asset.path)
          return new Response(body, { status: asset.status, headers: { "content-type": asset.mime, ...asset.headers } })
        }
        return new Response("not found", { status: 404 })
      },
    })
    const page = await Page.open(devtools)
    if (mobile) {
      await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
    } else {
      await page.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
    }
    const url = `http://127.0.0.1:${server.port}/api/review/${bundle}?t=${encodeURIComponent(token)}`
    await page.goto(url)
    check(`${label}: four items listed`, (await page.eval<number>("document.querySelectorAll('.items [data-go]').length")) === 4)
    check(`${label}: layout`, (await page.eval<string>("getComputedStyle(document.getElementById('shell')).display")) === (mobile ? "flex" : "grid"))

    const frameRect = (item: string) =>
      page.eval<{ x: number; y: number; w: number; h: number }>(`(() => { const f = document.querySelector('iframe[data-item="${item}"]');
        f.scrollIntoView({ block: "center" }); const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
    const inFrame = (item: string, expression: string) =>
      page.eval(`(() => { const w = document.querySelector('iframe[data-annotator][data-item="${item}"]').contentWindow; return (${expression}) })()`)
    // Draws a box in the middle of the annotator stage and types a note.
    async function drawBox(item: string, text: string) {
      await inFrame(item, `w.document.querySelector('[data-mode="rect"]').click()`)
      await sleep(150)
      const frame = await frameRect(item)
      const stage = (await inFrame(item, `(() => { const r = w.document.getElementById('viewport').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)) as { x: number; y: number; w: number; h: number }
      const cx = frame.x + stage.x + stage.w / 2
      const cy = frame.y + stage.y + stage.h / 2
      await page.drag(mobile, cx - 40, cy - 30, cx + 40, cy + 30)
      const opened = await page.until(`document.querySelector('iframe[data-annotator][data-item="${item}"]').contentWindow.document.getElementById('note-dialog').open`, 5000).catch(() => false)
      check(`${label}: ${item} note dialog opened by ${mobile ? "touch" : "mouse"} drag`, opened)
      if (!opened) return
      await inFrame(item, `(() => { const t = w.document.getElementById('note-text'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new w.Event('input', { bubbles: true })); w.document.getElementById('note-form').requestSubmit(); return true })()`)
    }
    const draft = () => page.eval<any>(`JSON.parse(localStorage.getItem('opencode.review.draft.${bundle}') || 'null')`)

    // Image
    await page.until(`document.querySelector('iframe[data-annotator][data-item="shot"]').dataset.ready === "1"`)
    await page.until(`document.querySelector('iframe[data-annotator][data-item="shot"]').contentWindow.EditHereWeb.sessionKind() === "image"`)
    check(`${label}: image loaded into the annotator`, true)
    await drawBox("shot", "阴影方向反了")
    await page.until(`(JSON.parse(localStorage.getItem('opencode.review.draft.${bundle}')||'{}').items?.shot?.assets?.s?.annotations||[]).length > 0`, 5000).catch(() => undefined)
    const imageMarks = (await draft())?.items?.shot?.assets?.s?.annotations ?? []
    check(`${label}: image mark saved to the draft`, imageMarks.length === 1 && imageMarks[0].text === "阴影方向反了" && imageMarks[0].shape === "rect", imageMarks)
    await page.key("p", { code: "KeyP", text: "p" })

    // Video
    await page.key("j", { code: "KeyJ", text: "j" })
    await page.until(`document.querySelector('iframe[data-annotator][data-item="clip"]').contentWindow.EditHereWeb?.sessionKind() === "video"`, 20_000)
    check(`${label}: video loaded from the Range route`, true)
    const before = (await inFrame("clip", "w.EditHereWeb.currentTimestampUs()")) as number
    for (let i = 0; i < 5; i++) await inFrame("clip", "w.EditHereWeb.stepFrame(1).then(() => true)")
    const after = (await inFrame("clip", "w.EditHereWeb.currentTimestampUs()")) as number
    check(`${label}: five frame steps at 10 fps move ~0.5 s`, after - before > 400_000 && after - before < 600_000, { before, after })
    await drawBox("clip", "拖尾断开")
    await page.until(`(JSON.parse(localStorage.getItem('opencode.review.draft.${bundle}')||'{}').items?.clip?.assets?.c?.annotations||[]).length > 0`, 5000).catch(() => undefined)
    const videoMarks = (await draft())?.items?.clip?.assets?.c?.annotations ?? []
    check(`${label}: video mark carries time and frame`, videoMarks.length === 1 && videoMarks[0].frame?.index === 5 && videoMarks[0].frame?.timeMs > 400, videoMarks)
    const raw = JSON.stringify((await draft())?.items?.clip?.assets?.c?.raw ?? {})
    check(`${label}: draft has no embedded image data`, !raw.includes("data:image"), raw.length)
    await page.key("f", { code: "KeyF", text: "f" })

    // Diff
    await page.key("j", { code: "KeyJ", text: "j" })
    await page.eval(`document.querySelector('[data-form-option][data-item="diff"][data-option="pass"]').click()`)

    // Custom page: press its own button inside the sandbox.
    await page.key("j", { code: "KeyJ", text: "j" })
    const sandbox = await page.eval<string>(`document.querySelector('iframe[data-custom]').getAttribute("sandbox")`)
    check(`${label}: custom iframe sandbox`, sandbox === "allow-scripts allow-forms", sandbox)
    await sleep(500)
    // Click the page's own button inside the sandbox; the bridge carries the answer out by postMessage.
    const clicked = await page.evalInFrame<boolean>("/ui/index.html", `(document.getElementById("pick").click(), typeof window.opencodeReview === "object")`).catch((e) => String(e))
    check(`${label}: bridge helper injected into the custom page`, clicked === true, clicked)
    await page.until(`JSON.parse(localStorage.getItem('opencode.review.draft.${bundle}')||'{}').items?.ui?.custom?.preset === "night"`, 5000).catch(() => undefined)
    const ui = (await draft())?.items?.ui
    check(`${label}: custom page result, verdict and text reached the draft`, ui?.custom?.preset === "night" && ui?.verdict === "fail" && ui?.text === "夜景太暗", ui ?? null)
    if (ui?.custom?.preset !== "night") console.log("  logs:", page.logs)
    const blocked = await page.eval<boolean>(`(() => { try { return !document.querySelector('iframe[data-custom]').contentWindow.document } catch { return true } })()`)
    check(`${label}: shell cannot reach into the custom page (opaque origin)`, blocked)

    // Refresh keeps everything.
    await page.goto(url)
    const kept = await draft()
    check(`${label}: draft survives a reload`, kept?.items?.shot?.assets?.s?.annotations?.length === 1 && kept?.items?.clip?.assets?.c?.annotations?.length === 1 && kept?.items?.ui?.custom?.preset === "night")
    await page.until(`document.querySelector('iframe[data-annotator][data-item="shot"]').contentWindow.EditHereWeb?.sessionKind() === "image"`).catch(() => undefined)

    // Submit with Ctrl+Enter.
    await page.key("Enter", { code: "Enter", modifiers: 2 })
    await page.until(`document.body.textContent.includes("已提交")`, 30_000).catch(() => undefined)
    check(`${label}: submitted page shown`, await page.eval<boolean>(`document.body.textContent.includes("已提交")`))
    const feedback = JSON.parse(await fs.readFile(path.join(root, bundle, "feedback", "feedback.json"), "utf8").catch(() => "{}"))
    const byId = Object.fromEntries((feedback.items ?? []).map((item: any) => [item.id, item]))
    check(`${label}: decision changes`, feedback.decision === "changes", feedback.decision)
    check(`${label}: image pass with one box`, byId.shot?.answers?.verdict === "pass" && byId.shot?.assets?.[0]?.annotations?.length === 1, byId.shot)
    check(`${label}: video fail with a frame mark and a frame PNG`, byId.clip?.answers?.verdict === "fail" && byId.clip?.assets?.[0]?.annotations?.[0]?.frame?.index === 5 && byId.clip?.assets?.[0]?.files?.length === 1, byId.clip)
    check(`${label}: diff form pass`, byId.diff?.answers?.verdict === "pass", byId.diff)
    check(`${label}: custom result`, byId.ui?.custom?.preset === "night" && byId.ui?.verdict === "fail", byId.ui)
    const text = prompts[0]?.text ?? ""
    check(`${label}: written-back prompt`, text.includes("阴影方向反了") && text.includes("(frame 5)") && text.includes('page result: {"preset":"night"'), text)
    check(`${label}: prompt attaches the snapshots`, (prompts[0]?.files?.length ?? 0) >= 2, prompts[0]?.files?.map((f) => f.name))
    const again = await fetch(url)
    check(`${label}: link is spent after submit`, (await again.text()).includes("已经提交过"))
    page.close()
  }

  await scenario(false)
  await scenario(true)
} catch (error) {
  failures.push(String(error))
  console.error(error)
} finally {
  server?.stop(true)
  chrome.kill()
  await chrome.exited
  await fs.rm(temp, { recursive: true, force: true })
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed")
process.exit(failures.length ? 1 : 0)
