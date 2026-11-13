export * as ReviewPage from "./page.js"

import type { ReviewContext } from "./context.js"
import type { ReviewDecide } from "./decide.js"
import { ReviewAnnotator } from "./annotator.js"
import { ReviewRequest } from "./request.js"
import { SCRIPT } from "./shell-client.js"
import { ReviewShell } from "./shell.js"
import type { ReviewState } from "./state.js"

export interface FileDiff {
  readonly file: string
  readonly patch: string
  readonly additions: number
  readonly deletions: number
  readonly status: string
}

const PATCH_LIMIT = 40_000
const TOTAL_LIMIT = 400_000
const PREVIEW_LINES = 50

export function escape(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

/** JSON for a <script type="application/json"> tag: escapes <, > and & so the parser cannot break out. */
export function jsonScript(value: unknown) {
  return JSON.stringify(value).replace(/[<>&]/g, (char) => `\\u00${char.charCodeAt(0).toString(16)}`)
}

const STYLE = `
:root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--bg:#fff;--card:#f6f8fa;--line:#d1d9e0;--add:#1a7f37;--del:#cf222e;--accent:#0969da;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;--bar:0px;--vv:0px;--safe:env(safe-area-inset-bottom,0px)}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--card:#151b23;--line:#3d444d;--add:#3fb950;--del:#f85149;--accent:#4493f8;--ok:#3fb950;--warn:#d29922;--bad:#f85149}}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg)}
button,textarea,input{font:inherit;color:inherit}button{touch-action:manipulation;-webkit-tap-highlight-color:transparent}
h1{font-size:1.15rem;margin:0 0 2px}h2{font-size:.95rem;font-weight:600;margin:0 0 6px}
.muted{color:var(--muted);font-size:13px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0}
.summary,.request,.turn,.note{white-space:pre-wrap;overflow-wrap:anywhere}
.turns{list-style:none;margin:0;padding:0}.turns li{padding:8px 0;border-top:1px solid var(--line)}.turns li:first-child{border-top:0}
.role{font-size:12px;color:var(--muted);margin-right:6px}
.files{display:flex;flex-direction:column;gap:6px;margin:8px 0 12px}
.files a{color:var(--fg);text-decoration:none;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.files a .name{word-break:break-all}details.file{border-top:1px solid var(--line);padding:8px 0}details.file:first-of-type{border-top:0}
summary{cursor:pointer;word-break:break-all}.add{color:var(--add)}.del{color:var(--del)}
pre{overflow:auto;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;margin:8px 0 0;padding:8px;background:var(--bg);border-radius:6px;max-width:100%}
pre .a{color:var(--add)}pre .d{color:var(--del)}pre .h{color:var(--accent)}
details.more{margin-top:6px}details.more>summary{color:var(--accent);font-size:14px}
label.comment{display:block;margin:10px 0 0;font-size:13px;color:var(--muted)}
textarea{width:100%;min-height:88px;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);margin-top:6px;resize:vertical}
.overall-text{min-height:72px}
.state{border-left:4px solid var(--accent);max-width:860px;margin:16px auto;padding:16px}.state.ok{border-left-color:var(--ok)}.state.warn{border-left-color:var(--warn)}.state.bad{border-left-color:var(--bad)}
#shell{display:flex;flex-direction:column;min-height:100dvh;padding-bottom:calc(var(--bar) + var(--vv) + var(--safe))}
.top{padding:12px 16px 8px;border-bottom:1px solid var(--line);background:var(--bg);position:sticky;top:0;z-index:3}
.top-row{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.counter{font-size:13px;color:var(--muted);white-space:nowrap;padding-top:4px}
.wait{margin:8px 0 0;padding:8px 10px;border-left:4px solid var(--warn);background:var(--card);border-radius:0 8px 8px 0;font-size:14px}
.context-panel{margin:8px 16px 0}
.workspace{display:flex;flex-direction:column;flex:1;min-height:0}
.items{display:flex;gap:8px;overflow:auto;padding:8px 16px;border-bottom:1px solid var(--line);-webkit-overflow-scrolling:touch}
.items button{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 10px;min-height:44px;border:1px solid var(--line);border-radius:8px;background:var(--bg);max-width:200px;text-align:left}
.items button[aria-current="page"]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.items .item-title{font-size:14px;font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.items .item-status{font-size:12px;color:var(--muted)}
.items button[data-status="pass"] .item-status{color:var(--ok)}
.items button[data-status="fail"] .item-status{color:var(--bad)}
.stage{position:relative;flex:1;padding:12px 16px 8px;min-width:0}
.item-pane[hidden],.asset-pane[hidden],.item-feedback[hidden]{display:none}
.item-head{margin-bottom:8px}
.switcher{display:flex;gap:6px;overflow:auto;padding:0 0 8px}
.switcher button{flex:0 0 auto;padding:6px 10px;min-height:36px;border:1px solid var(--line);border-radius:999px;background:var(--bg);font-size:13px}
.switcher button[aria-current="true"]{border-color:var(--accent);color:var(--accent)}
figure{margin:0}figure img,figure video,.annotator-frame{display:block;max-width:100%;height:auto;max-height:min(70dvh,720px);margin:0 auto;border-radius:6px;border:1px solid var(--line);background:var(--bg)}.annotator-frame{width:100%;height:min(70dvh,720px);max-height:none}
figcaption{font-size:13px;color:var(--muted);margin-top:4px;word-break:break-all;text-align:center}
.custom-frame{width:100%;min-height:min(70dvh,640px);border:1px solid var(--line);border-radius:8px;background:var(--bg)}
.step{position:absolute;top:40%;width:44px;height:44px;border:1px solid var(--line);border-radius:22px;background:color-mix(in srgb,var(--bg) 85%,transparent);color:var(--fg);z-index:2;font-size:20px;line-height:1}
.step.prev{left:4px}.step.next{right:4px}.step:disabled{opacity:.3}
.pane-feedback{border-top:1px solid var(--line);background:var(--card);padding:8px 16px 12px}
.drawer-handle{display:flex;width:100%;align-items:center;justify-content:center;gap:8px;min-height:36px;border:0;background:none;color:var(--muted);font-size:13px}
.drawer-handle::before{content:"";width:36px;height:4px;border-radius:2px;background:var(--line)}
.feedback-body{max-height:40dvh;overflow:auto}
.verdict{display:flex;gap:8px;margin:8px 0}
.verdict button,.check button,.choices button{flex:1;min-height:44px;border:1px solid var(--line);border-radius:8px;background:var(--bg)}
.verdict button[aria-pressed="true"][data-verdict="pass"],.check button[aria-pressed="true"][data-verdict="pass"]{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 16%,var(--bg));color:var(--ok)}
.verdict button[aria-pressed="true"][data-verdict="fail"],.check button[aria-pressed="true"][data-verdict="fail"]{border-color:var(--bad);background:color-mix(in srgb,var(--bad) 16%,var(--bg));color:var(--bad)}
.checks{display:flex;flex-direction:column;gap:8px;margin:10px 0}
.check{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
.check .check-label{flex:1 1 140px;font-size:14px}
.check .verdict{flex:1 1 180px;margin:0}
.file-review{margin-top:8px}
.bar{position:fixed;left:0;right:0;bottom:var(--vv);z-index:4;background:var(--bg);border-top:1px solid var(--line);padding:8px 16px calc(8px + var(--safe))}
.choices{display:flex;gap:8px;flex-wrap:wrap}
.choices button{flex:1 1 30%;font-size:14px}
.choices button[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
.submit-row{display:flex;align-items:center;gap:12px;margin-top:8px}
.submit-row .count{flex:1;font-size:13px;color:var(--muted)}
[data-submit]{flex:0 0 auto;min-width:140px;min-height:44px;padding:0 16px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:16px}
[data-submit]:disabled{opacity:.6}
.error{color:var(--bad);font-size:13px;margin:6px 0 0}
.error[hidden]{display:none}
noscript{display:block;padding:8px 16px;color:var(--warn)}
@media (max-width:899px){
  .pane-feedback{position:sticky;bottom:calc(var(--bar) + var(--vv) + var(--safe));z-index:3}
  .pane-feedback:not(.open) .feedback-body{max-height:7.5rem}
  .pane-feedback.open .feedback-body{max-height:50dvh}
}
@media (min-width:640px){.files{flex-direction:row;flex-wrap:wrap}.files a{flex:1 1 240px}}
@media (min-width:900px){
  #shell{display:grid;grid-template-columns:240px minmax(0,1fr) 300px;grid-template-rows:auto auto 1fr auto;height:100dvh;padding-bottom:0}
  .top{grid-column:1/-1;position:static}
  .context-panel{grid-column:1;grid-row:2;margin:8px;max-height:28vh;overflow:auto}
  .workspace{display:contents}
  .items{grid-column:1;grid-row:3;flex-direction:column;border:0;padding:8px;overflow:auto}
  .items button{max-width:none;width:100%}
  .stage{grid-column:2;grid-row:2/4;overflow:auto;padding:16px}
  .step{display:none}
  .pane-feedback{grid-column:3;grid-row:2/4;border:0;border-left:1px solid var(--line);overflow:auto;padding:12px 16px}
  .drawer-handle{display:none}
  .feedback-body{max-height:none}
  .bar{position:static;grid-column:1/-1;grid-row:4}
}
`

function layout(title: string, body: string, extra = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${escape(title)}</title><style>${STYLE}</style></head><body>${body}${extra}</body></html>`
}

function patchHTML(patch: string) {
  return patch
    .split("\n")
    .map((line) => {
      const safe = escape(line)
      if (line.startsWith("+") && !line.startsWith("+++")) return `<span class="a">${safe}</span>`
      if (line.startsWith("-") && !line.startsWith("---")) return `<span class="d">${safe}</span>`
      if (line.startsWith("@@")) return `<span class="h">${safe}</span>`
      return safe
    })
    .join("\n")
}

function patchBlock(patch: string, clipped: boolean) {
  const lines = patch.split("\n")
  const suffix = clipped ? "\n…（已截断）" : ""
  if (lines.length <= PREVIEW_LINES) return `<pre>${patchHTML(patch)}${suffix}</pre>`
  const head = lines.slice(0, PREVIEW_LINES).join("\n")
  const rest = lines.slice(PREVIEW_LINES).join("\n")
  return `<pre>${patchHTML(head)}</pre><details class="more"><summary>显示全部</summary><pre>${patchHTML(rest)}${suffix}</pre></details>`
}

export function diffsFor(item: ReviewRequest.StoredItem, diffs: ReadonlyArray<FileDiff>) {
  const files = item.diff?.files
  if (!files || files.length === 0) return diffs
  const allow = new Set(files)
  return diffs.filter((diff) => allow.has(diff.file))
}

export function info(item: ReviewRequest.StoredItem, diffs: ReadonlyArray<FileDiff> = []): ReviewShell.ItemInfo {
  const assetIDs =
    item.kind === "diff" ? diffsFor(item, diffs).map((diff) => diff.file) : item.assets.map((asset) => asset.id)
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    ...(item.feedback ? { feedback: item.feedback } : {}),
    assetIDs,
  }
}

function fileReview(itemID: string, file: string) {
  return `<div class="file-review">
<div class="verdict" role="group" aria-label="对 ${escape(file)} 的结论">
<button type="button" data-verdict="pass" data-scope="asset" data-item="${escape(itemID)}" data-asset="${escape(file)}">通过</button>
<button type="button" data-verdict="fail" data-scope="asset" data-item="${escape(itemID)}" data-asset="${escape(file)}">不通过</button>
</div>
<label class="comment">对这个文件的意见（可选）<textarea data-scope="asset-text" data-item="${escape(itemID)}" data-asset="${escape(file)}" placeholder="只针对 ${escape(file)} 的意见，会和总体意见一起提交"></textarea></label>
</div>`
}

export function diffHTML(diffs: ReadonlyArray<FileDiff>, itemID = "diff") {
  if (diffs.length === 0) return `<p class="muted">本轮没有文件改动。</p>`
  let budget = TOTAL_LIMIT
  const additions = diffs.reduce((sum, diff) => sum + diff.additions, 0)
  const deletions = diffs.reduce((sum, diff) => sum + diff.deletions, 0)
  const toc = diffs
    .map(
      (diff, index) =>
        `<a href="#d-${escape(itemID)}-${index}"><span class="name">${escape(diff.file)}</span><span><span class="add">+${diff.additions}</span> <span class="del">-${diff.deletions}</span></span></a>`,
    )
    .join("")
  const files = diffs.map((diff, index) => {
    const clipped = diff.patch.length > PATCH_LIMIT || diff.patch.length > budget
    const patch = diff.patch.slice(0, Math.max(0, Math.min(PATCH_LIMIT, budget)))
    budget -= patch.length
    const open = diffs.length === 1 ? " open" : ""
    return `<details class="file" id="d-${escape(itemID)}-${index}"${open}><summary>${escape(diff.file)} <span class="add">+${diff.additions}</span> <span class="del">-${diff.deletions}</span> <span class="muted">${escape(diff.status)}</span></summary>${patchBlock(patch, clipped)}${fileReview(itemID, diff.file)}</details>`
  })
  return `<p class="muted">${diffs.length} 个文件 <span class="add">+${additions}</span> <span class="del">-${deletions}</span></p><nav class="files" aria-label="文件列表">${toc}</nav>${files.join("")}`
}

function contextHTML(review: ReviewState.Review, context: ReviewContext.Context | undefined) {
  const title = context?.title ?? review.title
  const request = context?.request
  const recent = context?.recent ?? []
  const turns =
    recent.length === 0
      ? `<p class="muted">没有可供展示的最近对话。</p>`
      : `<ol class="turns">${recent
          .map(
            (turn) =>
              `<li class="${turn.role}"><span class="role">${turn.role === "user" ? "用户" : "助手"}</span><div class="turn">${escape(turn.text)}</div></li>`,
          )
          .join("")}</ol>`
  return `<details class="card context-panel"><summary>任务背景与摘要</summary>
<p><strong>会话</strong> ${escape(title)}</p>
<div class="muted">最初的请求</div>
${request ? `<div class="request">${escape(request)}</div>` : `<p class="muted">没有找到最初的请求。</p>`}
<div class="muted" style="margin-top:10px">最近对话</div>
${turns}
<section style="margin-top:10px"><h2>本轮摘要</h2><div class="summary">${escape(review.summary)}</div></section>
</details>`
}

/** Where the page loads a snapshotted file: the token rides in the path so a custom page's relative links work. */
export function assetURL(reviewID: string, token: string, item: string, file: string) {
  const path = file.split("/").map(encodeURIComponent).join("/")
  return `/api/review/${encodeURIComponent(reviewID)}/a/${encodeURIComponent(token)}/${encodeURIComponent(item)}/${path}`
}

function assetPane(
  review: ReviewState.Review,
  token: string,
  item: ReviewRequest.StoredItem,
  asset: ReviewRequest.StoredAsset,
  annotate = false,
) {
  const url = (file: string) => escape(assetURL(review.id, token, item.id, file))
  const caption = `<figcaption>${escape(asset.label ? `${asset.label} · ${asset.id}` : asset.id)}</figcaption>`
  if (item.kind === "video")
    return `<div class="asset-pane" data-asset="${escape(asset.id)}"><figure><video controls playsinline preload="metadata" src="${url(asset.stored.file)}"></video>${caption}</figure></div>`
  const compare = asset.compare
    ? `<details class="more"><summary>对比参考图</summary><img loading="lazy" alt="参考图" src="${url(asset.compare.file)}"></details>`
    : ""
  const image = annotate
    ? ""
    : `<img loading="lazy" alt="${escape(asset.label ?? asset.id)}" src="${url(asset.stored.file)}">`
  return `<div class="asset-pane" data-asset="${escape(asset.id)}" data-src="${url(asset.stored.file)}"><figure>${image}${caption}${compare}</figure></div>`
}

function itemPane(
  review: ReviewState.Review,
  token: string,
  item: ReviewRequest.StoredItem,
  diffs: ReadonlyArray<FileDiff>,
  diffError?: string,
) {
  const note = item.note ? `<p class="note">${escape(item.note)}</p>` : ""
  const head = `<header class="item-head"><h2>${escape(item.title)}</h2>${note}</header>`
  if (item.kind === "diff")
    return `<section class="item-pane" data-item="${escape(item.id)}" hidden>${head}<div class="viewer">${
      diffError ? `<p class="muted">${escape(diffError)}</p>` : diffHTML(diffsFor(item, diffs), item.id)
    }</div></section>`
  if (item.kind === "custom" && item.custom) {
    const src = escape(assetURL(review.id, token, item.id, item.custom.entry))
    return `<section class="item-pane" data-item="${escape(item.id)}" hidden>${head}<iframe class="custom-frame" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src="${src}" title="${escape(item.title)}"></iframe></section>`
  }
  const switcher =
    item.assets.length > 1
      ? `<div class="switcher" role="tablist" aria-label="资产">${item.assets
          .map(
            (asset) =>
              `<button type="button" role="tab" data-asset-go="${escape(asset.id)}">${escape(asset.label ?? asset.id)}</button>`,
          )
          .join("")}</div>`
      : ""
  const annotate = item.kind === "image" && Boolean(item.feedback?.annotate)
  const frame = annotate
    ? `<iframe class="annotator-frame" data-annotator data-item="${escape(item.id)}" title="${escape("标注：" + item.title)}" src="${escape(ReviewAnnotator.route(review.id, token))}"></iframe>`
    : ""
  const assets = item.assets.map((asset) => assetPane(review, token, item, asset, annotate)).join("")
  return `<section class="item-pane" data-item="${escape(item.id)}" hidden>${head}${switcher}<div class="viewer">${frame}${assets}</div></section>`
}

function verdictButtons(scope: "item" | "asset", itemID: string, asset?: string) {
  const extra = asset
    ? ` data-item="${escape(itemID)}" data-asset="${escape(asset)}"`
    : ` data-item="${escape(itemID)}"`
  return `<div class="verdict" role="group" aria-label="结论">
<button type="button" data-verdict="pass" data-scope="${scope}"${extra}>通过</button>
<button type="button" data-verdict="fail" data-scope="${scope}"${extra}>不通过</button>
</div>`
}

function itemFeedback(item: ReviewRequest.StoredItem, files: ReadonlyArray<FileDiff>) {
  const feedback = item.feedback
  const perAsset = Boolean(feedback?.verdict && (item.kind === "diff" ? files.length > 0 : item.assets.length > 0))
  const itemLevel = Boolean(feedback?.required || (feedback?.verdict && !perAsset))
  const checks = feedback?.checks ?? []
  const assetBox =
    perAsset && item.kind !== "diff"
      ? `<div data-asset-feedback>
<p class="muted">本${item.kind === "video" ? "段视频" : "张图"}：<span data-current-asset></span></p>
${verdictButtons("asset", item.id)}
<label class="comment">意见（可选）<textarea data-scope="asset-text" data-item="${escape(item.id)}"></textarea></label>
</div>`
      : ""
  const itemBox = itemLevel ? `<div><p class="muted">本项结论</p>${verdictButtons("item", item.id)}</div>` : ""
  const checkBox =
    checks.length > 0
      ? `<div class="checks">${checks
          .map(
            (check) =>
              `<div class="check"><span class="check-label">${escape(check.label)}</span><div class="verdict" role="group" aria-label="${escape(check.label)}">
<button type="button" data-verdict="pass" data-scope="check" data-item="${escape(item.id)}" data-check="${escape(check.id)}">通过</button>
<button type="button" data-verdict="fail" data-scope="check" data-item="${escape(item.id)}" data-check="${escape(check.id)}">不通过</button>
</div></div>`,
          )
          .join("")}</div>`
      : ""
  return `<div class="item-feedback" data-feedback-for="${escape(item.id)}" hidden>
${assetBox}${itemBox}${checkBox}
<label class="comment">对本项的意见（可选）<textarea data-scope="item-text" data-item="${escape(item.id)}"></textarea></label>
</div>`
}

export function approval(input: {
  readonly review: ReviewState.Review
  readonly token: string
  readonly diffs: ReadonlyArray<FileDiff>
  readonly diffError?: string
  readonly context?: ReviewContext.Context
}) {
  const review = input.review
  const items = review.request?.items ?? [ReviewRequest.diffItem(review.id)]
  const payload = {
    id: review.id,
    token: input.token,
    submit: `/api/review/${encodeURIComponent(review.id)}/submit`,
    annotator: ReviewAnnotator.route(review.id, input.token),
    items: items.map((item) => {
      const base = info(item, input.diffs)
      if (item.kind !== "image" || !item.feedback?.annotate) return base
      const sources: Record<string, string> = {}
      for (const asset of item.assets) sources[asset.id] = assetURL(review.id, input.token, item.id, asset.stored.file)
      return { ...base, annotate: true, sources }
    }),
  }
  const wait =
    review.origin === "agent"
      ? `<p class="wait">${escape(ReviewRequest.describeWait(review.request?.wait, review.createdAt))}</p>`
      : ""
  const nav = items
    .map(
      (item) =>
        `<button type="button" data-go="${escape(item.id)}" data-status="unread"><span class="item-title">${escape(item.title)}</span><span class="item-status">未看</span></button>`,
    )
    .join("")
  const panes = items.map((item) => itemPane(review, input.token, item, input.diffs, input.diffError)).join("\n")
  const feedback = items.map((item) => itemFeedback(item, diffsFor(item, input.diffs))).join("\n")
  const body = `<div id="shell">
<header class="top"><div class="top-row"><div><h1>${escape(review.title)}</h1><div class="muted">${escape(review.directory)} · 有效期至 ${escape(new Date(review.expiresAt).toLocaleString("zh-CN", { hour12: false }))}</div></div><div class="counter" data-counter>第 1/${items.length} 项</div></div>${wait}</header>
${contextHTML(review, input.context)}
<noscript><style>.item-pane[hidden],.item-feedback[hidden],.asset-pane[hidden]{display:block!important}</style>请启用 JavaScript 后再提交审查。下面的内容和改动仍可查看。</noscript>
<div class="workspace">
<nav class="items" aria-label="审查项">${nav}</nav>
<div class="stage">
<button type="button" class="step prev" data-step="-1" aria-label="上一项">‹</button>
<button type="button" class="step next" data-step="1" aria-label="下一项">›</button>
${panes}
</div>
<aside class="pane-feedback">
<button type="button" class="drawer-handle" data-drawer aria-expanded="false">本项反馈</button>
<div class="feedback-body">${feedback}</div>
</aside>
</div>
<footer class="bar">
<div class="choices" role="group" aria-label="总体结论">
<button type="button" data-decision="continue" aria-pressed="true">没问题，继续</button>
<button type="button" data-decision="changes" aria-pressed="false">需要修改</button>
<button type="button" data-decision="stop" aria-pressed="false">先停下</button>
</div>
<label class="comment">总体意见（可选；选“需要修改”时请填写）<textarea class="overall-text" data-overall placeholder="写给 agent 的总体意见。对各文件和各项的意见写在对应位置，会一并提交。"></textarea></label>
<div class="submit-row"><span class="count" data-progress>已完成 0/${items.length}</span><button type="button" data-submit>提交全部</button></div>
<p class="error" data-error hidden></p>
</footer>
</div>`
  const extra = `<script type="application/json" id="review-data">${jsonScript(payload)}</script><script>${SCRIPT}</script>`
  return layout(`审查：${review.title}`, body, extra)
}

const MESSAGES: Record<
  Exclude<ReviewDecide.Outcome, "ok">,
  { title: string; body: string; status: number; kind: "ok" | "warn" | "bad" }
> = {
  invalid: { title: "链接无效", body: "这个审查链接无效或已被替换。", status: 404, kind: "bad" },
  used: { title: "已经提交过", body: "这个审查链接已经提交过，不能重复使用。", status: 409, kind: "warn" },
  expired: {
    title: "链接已过期",
    body: "这个审查链接已过期。回到电脑上继续，或在会话里运行 /review-remote now 重新发送。",
    status: 410,
    kind: "warn",
  },
  continued: {
    title: "已在电脑端继续",
    body: "这个会话在你打开链接之后已经在电脑上继续了，手机端的反馈不会再写回。",
    status: 409,
    kind: "warn",
  },
}

export function outcome(kind: Exclude<ReviewDecide.Outcome, "ok">) {
  const message = MESSAGES[kind]
  return {
    status: message.status,
    html: layout(
      message.title,
      `<section class="card state ${message.kind}"><h1>${message.title}</h1><p>${message.body}</p></section>`,
    ),
  }
}

export function submitted(decision: ReviewState.Decision) {
  const body =
    decision === "stop"
      ? "已记录：先停下。会话保持空闲，回到电脑后再处理。"
      : decision === "changes"
        ? "已把修改意见发给 agent，它会接着改。"
        : "已通知 agent 继续。"
  return layout("已提交", `<section class="card state ok"><h1>已提交</h1><p>${body}</p></section>`)
}

export function failed() {
  return {
    status: 502,
    html: layout(
      "提交失败",
      `<section class="card state bad"><h1>提交失败</h1><p>反馈没能写回会话，请稍后重试。</p></section>`,
    ),
  }
}
