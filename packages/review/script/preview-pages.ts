/**
 * Build a static GitHub Pages preview of the approval shell, with no live backend.
 *
 *   bun packages/review/script/preview-pages.ts
 *   bun packages/review/script/preview-pages.ts --out /tmp/review-preview
 *
 * Writes a self-contained site (default `packages/review/preview/dist`, gitignored) from the current approval shell.
 * Image and custom-page fixtures are generated here; the WebM is recorded once with
 * Chrome (if present) into `packages/review/preview/fixtures/` and committed so CI
 * does not need a browser. Exit 0 means the site was written.
 */
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"
import { ReviewCustom } from "../src/custom.js"
import { ReviewPage } from "../src/page.js"
import type { ReviewRequest } from "../src/request.js"
import { ReviewState } from "../src/state.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.join(here, "..")
const fixtures = path.join(pkg, "preview", "fixtures")
const annotatorPkg = path.join(pkg, "..", "review-annotator")
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome"

function arg(name: string, fallback: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const out = path.resolve(arg("--out", path.join(pkg, "preview", "dist")))

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
function stored(file: string, mime: string, bytes: Uint8Array, source: string): ReviewRequest.StoredFile {
  return { file, mime, size: bytes.length, sha256: sha256(bytes), source }
}

function crc32(buf: Uint8Array) {
  let c = ~0 >>> 0
  for (const b of buf) {
    c ^= b
    for (let i = 0; i < 8; i++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1
  }
  return ~c >>> 0
}
function pngChunk(type: string, data: Uint8Array) {
  const name = Buffer.from(type)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([name, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
/** A small 240×160 "night level" screenshot: sky, moon, ground, a simple character. No fonts. */
function nightPng() {
  const width = 240
  const height = 160
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      let r = 12, g = 18, b = 48
      if (y > 110) {
        r = 18
        g = 28
        b = 22 + ((x + y) % 7)
      }
      const moon = (x - 190) * (x - 190) + (y - 36) * (y - 36)
      if (moon < 18 * 18) {
        r = 230
        g = 230
        b = 200
      }
      if (x > 92 && x < 116 && y > 86 && y < 130) {
        r = 40
        g = 70
        b = 160
      }
      if (x > 96 && x < 112 && y > 70 && y < 90) {
        r = 230
        g = 200
        b = 170
      }
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array()),
  ])
}

const UI_HTML = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>画面设置</title>
<link rel="stylesheet" href="style.css">
</head><body>
<h1>画面设置</h1>
<p>选一个预设，意见会通过桥接回到审批页。</p>
<button type="button" id="night">选夜景预设</button>
<button type="button" id="day">选白昼预设</button>
<p id="restored"></p>
<script>
const apply = (preset, verdict, text) => {
  opencodeReview.setResult({ preset: preset, volume: preset === "night" ? 0.8 : 0.4 })
  opencodeReview.setVerdict(verdict)
  opencodeReview.setText(text)
}
document.getElementById("night").onclick = () => apply("night", "fail", "夜景太暗")
document.getElementById("day").onclick = () => apply("day", "pass", "白昼亮度合适")
addEventListener("opencode-review:hello", (e) => {
  const draft = e.detail.draft || {}
  document.getElementById("restored").textContent = draft.custom
    ? ("已恢复：" + JSON.stringify(draft.custom))
    : "还没有这项的草稿。"
})
</script>
</body></html>
`
const UI_CSS = `html,body{margin:0;padding:16px;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#111827;color:#e5e7eb}
h1{font-size:1.1rem;margin:0 0 8px}
button{display:block;width:100%;max-width:240px;min-height:44px;margin:8px 0;border:0;border-radius:8px;background:#2563eb;color:#fff;font:inherit}
#day{background:#0f766e}
#restored{color:#9ca3af;font-size:13px}
`

async function recordWebm(dest: string) {
  if (!existsSync(CHROME)) throw new Error("Chrome not found at " + CHROME + "; commit a WebM under preview/fixtures/clip.webm")
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "review-preview-webm-"))
  const chrome = Bun.spawn(
    [CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--mute-audio",
      "--autoplay-policy=no-user-gesture-required", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
    { stdout: "ignore", stderr: "pipe" },
  )
  try {
    const reader = chrome.stderr.getReader()
    let text = ""
    let port = 0
    while (!port) {
      const { value, done } = await reader.read()
      if (done) throw new Error("chrome exited: " + text)
      text += new TextDecoder().decode(value)
      const match = text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)
      if (match) port = Number(match[1])
    }
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)))
    let id = 0
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      const waiter = message.id && pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    })
    const send = (method: string, params: Record<string, unknown> = {}) => {
      const n = ++id
      ws.send(JSON.stringify({ id: n, method, params }))
      return new Promise<any>((resolve, reject) => pending.set(n, { resolve, reject }))
    }
    await send("Runtime.enable")
    const result = await send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const c = document.createElement("canvas"); c.width = 160; c.height = 120
        const g = c.getContext("2d")
        const paint = (n) => {
          g.fillStyle = "hsl(230,50%," + (18 + n * 2) + "%)"; g.fillRect(0, 0, 160, 120)
          g.fillStyle = "#eee"; g.beginPath(); g.arc(120, 28, 14, 0, Math.PI * 2); g.fill()
          g.fillStyle = "#245"; g.fillRect(0, 90, 160, 30)
          g.fillStyle = "#48c"; g.fillRect(60 + n, 70, 16, 28)
        }
        const stream = c.captureStream(10)
        const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" })
        const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
        rec.start()
        for (let n = 0; n < 10; n++) { paint(n); stream.getVideoTracks()[0].requestFrame?.(); await new Promise((r) => setTimeout(r, 100)) }
        await new Promise((r) => { rec.onstop = r; rec.stop() })
        const buf = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer())
        let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
        return btoa(bin)
      })()`,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    await fs.writeFile(dest, Buffer.from(result.result.value, "base64"))
    ws.close()
  } finally {
    chrome.kill()
    await chrome.exited.catch(() => undefined)
    await fs.rm(profile, { recursive: true, force: true })
  }
}

const LANDING_STYLE = `html,body{margin:0;background:#0d1117;color:#e6edf3;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:1.4rem;margin:0 0 8px}h2{font-size:1rem;margin:24px 0 8px}
.muted{color:#9198a1;font-size:14px}
.banner{margin:16px 0;padding:10px 12px;border-left:4px solid #d29922;background:#151b23;border-radius:0 8px 8px 0}
.primary{display:inline-block;margin:16px 0;padding:12px 18px;min-height:44px;border-radius:10px;background:#0969da;color:#fff;text-decoration:none;font-weight:600}
ul{padding-left:1.2em}a{color:#4493f8}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}`

function landing() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><title>远程审查 · 静态预览</title><style>${LANDING_STYLE}</style></head>
<body><main>
<h1>远程审查 · 静态预览</h1>
<p class="banner" role="status">这是静态预览，提交不会写回会话。打开审批页后可以标注、逐帧、回答设置页并点提交，只会在本页看到「已提交」，不会调用任何后端。</p>
<p>演示里有四项：一张夜景关卡截图（可标注）、一小段过场动画（可逐帧标注）、一处代码改动，以及一个带 <code>opencodeReview</code> 桥接的设置页。适合在手机或桌面浏览器里点一点，看审批壳的样子。</p>
<p><a class="primary" href="review.html">打开审批页</a></p>
<h2>其他状态页</h2>
<ul>
<li><a href="submitted.html">已提交</a></li>
<li><a href="invalid.html">链接无效</a></li>
<li><a href="expired.html">链接已过期</a></li>
<li><a href="used.html">已经提交过</a></li>
<li><a href="continued.html">已在电脑端继续</a></li>
</ul>
<h2>许可</h2>
<p class="muted">审批页本身与本仓库其余部分一样是 MIT。<a href="LICENSE">标注器</a>是 EditHere 的修改副本，按 <a href="LICENSE">PolyForm Noncommercial 1.0.0</a> 授权，说明见 <a href="NOTICE">NOTICE</a>。</p>
</main></body></html>`
}

function withHome(html: string) {
  const link = `<p class="muted" style="max-width:860px;margin:16px auto 32px;text-align:center"><a href="index.html">返回预览首页</a></p>`
  const index = html.toLowerCase().lastIndexOf("</body>")
  return index >= 0 ? html.slice(0, index) + link + html.slice(index) : html + link
}

async function ensureFixtures() {
  await fs.mkdir(path.join(fixtures, "ui"), { recursive: true })
  const pngPath = path.join(fixtures, "shot.png")
  if (!existsSync(pngPath)) await fs.writeFile(pngPath, nightPng())
  const webmPath = path.join(fixtures, "clip.webm")
  if (!existsSync(webmPath)) {
    console.log("recording clip.webm with Chrome…")
    await recordWebm(webmPath)
  }
  const uiHtml = path.join(fixtures, "ui", "index.html")
  const uiCss = path.join(fixtures, "ui", "style.css")
  if (!existsSync(uiHtml)) await fs.writeFile(uiHtml, UI_HTML)
  if (!existsSync(uiCss)) await fs.writeFile(uiCss, UI_CSS)
  return {
    png: await fs.readFile(pngPath),
    webm: await fs.readFile(webmPath),
    uiHtml: await fs.readFile(uiHtml, "utf8"),
    uiCss: await fs.readFile(uiCss, "utf8"),
  }
}

async function copyAnnotator(dest: string) {
  const build = path.join(annotatorPkg, "build.mjs")
  if (existsSync(build)) {
    const proc = Bun.spawnSync(["node", build], { cwd: annotatorPkg, stdout: "inherit", stderr: "inherit" })
    if (proc.exitCode !== 0) throw new Error("annotator build failed")
  }
  const src = path.join(annotatorPkg, "annotator.html")
  if (!existsSync(src)) throw new Error("missing " + src)
  await fs.copyFile(src, path.join(dest, "annotator.html"))
  await fs.copyFile(path.join(annotatorPkg, "LICENSE"), path.join(dest, "LICENSE"))
  await fs.copyFile(path.join(annotatorPkg, "NOTICE"), path.join(dest, "NOTICE"))
}

const diffs: ReviewPage.FileDiff[] = [
  {
    file: "src/lighting.ts",
    patch: "@@ -12,7 +12,8 @@ export function shade(level: Level) {\n-  const ambient = 0.15\n+  const ambient = 0.08\n   const moon = level.night ? 0.6 : 0\n+  // TODO: 夜景阴影方向和地面亮度还不对\n   return mix(ambient, moon)\n }",
    additions: 2,
    deletions: 1,
    status: "modified",
  },
]

async function main() {
  const media = await ensureFixtures()
  await fs.rm(out, { recursive: true, force: true })
  await fs.mkdir(path.join(out, "assets", "shot"), { recursive: true })
  await fs.mkdir(path.join(out, "assets", "clip"), { recursive: true })
  await fs.mkdir(path.join(out, "assets", "ui"), { recursive: true })
  await fs.writeFile(path.join(out, "assets", "shot", "shot.png"), media.png)
  await fs.writeFile(path.join(out, "assets", "clip", "clip.webm"), media.webm)
  await fs.writeFile(path.join(out, "assets", "ui", "index.html"), ReviewCustom.inject(media.uiHtml))
  await fs.writeFile(path.join(out, "assets", "ui", "style.css"), media.uiCss)
  await fs.writeFile(path.join(out, ".nojekyll"), "")
  await copyAnnotator(out)

  const review: ReviewState.Review = {
    id: "preview",
    sessionID: "demo",
    directory: "demo/night-level",
    title: "夜景关卡截图与设置页",
    summary: "看一张夜景关卡截图、一小段过场动画、一处光照代码改动，以及一个可切换预设的设置页。这是静态预览，提交不会写回任何会话。",
    tokenHash: "preview",
    marker: 0,
    createdAt: Date.parse("2026-11-14T00:00:00+08:00"),
    expiresAt: Date.parse("2099-12-31T16:00:00+08:00"),
    status: "open",
    origin: "now",
    request: {
      items: [
        {
          id: "shot",
          kind: "image",
          title: "关卡截图",
          note: "请看阴影方向和地面亮度。",
          bundle: "preview",
          feedback: {
            annotate: true,
            form: [
              {
                id: "verdict",
                type: "choice",
                label: "结论",
                required: true,
                options: [
                  { id: "pass", label: "通过" },
                  { id: "fail", label: "不通过" },
                ],
              },
              {
                id: "checks",
                type: "multi",
                label: "还需要看",
                options: [
                  { id: "shadow", label: "阴影方向" },
                  { id: "ground", label: "地面亮度" },
                ],
              },
              {
                id: "comment",
                type: "text",
                label: "修改意见",
                required: true,
                placeholder: "选“不通过”时请说明要改什么",
                when: { field: "verdict", equals: "fail" },
              },
            ],
          },
          assets: [{ id: "s", label: "夜景", stored: stored("shot.png", "image/png", media.png, "shot.png") }],
        },
        {
          id: "clip",
          kind: "video",
          title: "过场动画",
          note: "可以逐帧看拖尾。",
          bundle: "preview",
          feedback: {
            annotate: true,
            form: [
              {
                id: "feel",
                type: "choice",
                label: "观感",
                required: true,
                options: [
                  { id: "smooth", label: "流畅" },
                  { id: "stutter", label: "卡顿" },
                  { id: "again", label: "再看一遍" },
                ],
              },
              { id: "note", type: "text", label: "备注", placeholder: "可选" },
            ],
          },
          assets: [{ id: "c", label: "动画", stored: stored("clip.webm", "video/webm", media.webm, "clip.webm"), fps: 10 }],
        },
        {
          id: "diff",
          kind: "diff",
          title: "代码改动",
          bundle: "preview",
          feedback: {
            form: [
              {
                id: "merge",
                type: "choice",
                label: "这次改动",
                required: true,
                options: [
                  { id: "ok", label: "可以合入" },
                  { id: "rework", label: "需要再改" },
                ],
              },
              {
                id: "comment",
                type: "text",
                label: "具体意见",
                required: true,
                placeholder: "选“需要再改”时请说明",
                when: { field: "merge", equals: "rework" },
              },
            ],
          },
          assets: [],
          diff: { files: ["src/lighting.ts"] },
        },
        {
          id: "ui",
          kind: "custom",
          title: "画面设置",
          bundle: "preview",
          feedback: { form: [{ id: "note", type: "text", label: "补充说明", placeholder: "对设置页的额外意见（可选）" }] },
          assets: [],
          custom: {
            entry: "index.html",
            files: [stored("style.css", "text/css", Buffer.from(media.uiCss), "style.css")],
          },
        },
      ],
    },
  }

  const preview = { assetBase: "assets", annotator: "annotator.html", submitted: "submitted.html" }
  const html = ReviewPage.approval({
    review,
    token: "",
    diffs,
    preview,
    context: {
      title: "夜景关卡",
      request: "请审一下夜景关卡的截图、过场动画和设置页，阴影方向和亮度是否合适。",
      recent: [
        { role: "user", text: "夜景的阴影好像反了，亮度也偏暗。" },
        { role: "assistant", text: "我调了环境光，并把设置页做成可以选预设的预览。请看看截图、动画和改动。" },
      ],
    },
  })
  if (html.includes("/api/review") || html.includes("?t=")) throw new Error("preview HTML still has live API or token URLs")
  await fs.writeFile(path.join(out, "review.html"), html)
  await fs.writeFile(path.join(out, "index.html"), landing())
  await fs.writeFile(path.join(out, "submitted.html"), withHome(ReviewPage.submitted("continue")))
  for (const kind of ["invalid", "expired", "used", "continued"] as const)
    await fs.writeFile(path.join(out, `${kind}.html`), withHome(ReviewPage.outcome(kind).html))

  const files = await fs.readdir(out, { recursive: true })
  console.log("wrote " + out)
  for (const file of files.sort()) {
    const full = path.join(out, file)
    const st = await fs.stat(full)
    if (st.isFile()) console.log(`  ${file}  ${st.size} bytes`)
  }
}

await main()
