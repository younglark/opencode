export * as ReviewPage from "./page.js"

import type { ReviewContext } from "./context.js"
import type { ReviewDecide } from "./decide.js"
import { ReviewRequest } from "./request.js"
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

const STYLE = `
:root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--bg:#fff;--card:#f6f8fa;--line:#d1d9e0;--add:#1a7f37;--del:#cf222e;--accent:#0969da;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--card:#151b23;--line:#3d444d;--add:#3fb950;--del:#f85149;--accent:#4493f8;--ok:#3fb950;--warn:#d29922;--bad:#f85149}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:860px;margin:0 auto;padding:16px 16px 32px}h1{font-size:1.25rem;margin:4px 0 2px}h2{font-size:.8rem;font-weight:600;margin:0 0 8px;color:var(--muted);letter-spacing:.02em}
.muted{color:var(--muted);font-size:13px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0}
.summary,.request,.turn{white-space:pre-wrap;overflow-wrap:anywhere}.turns{list-style:none;margin:0;padding:0}.turns li{padding:8px 0;border-top:1px solid var(--line)}.turns li:first-child{border-top:0}
.role{font-size:12px;color:var(--muted);margin-right:6px}.files{display:flex;flex-direction:column;gap:6px;margin:8px 0 12px}
.files a{color:var(--fg);text-decoration:none;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.files a .name{word-break:break-all}details.file{border-top:1px solid var(--line);padding:8px 0}details.file:first-of-type{border-top:0}
summary{cursor:pointer;word-break:break-all}.add{color:var(--add)}.del{color:var(--del)}
pre{overflow:auto;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;margin:8px 0 0;padding:8px;background:var(--bg);border-radius:6px;max-width:100%}
pre .a{color:var(--add)}pre .d{color:var(--del)}pre .h{color:var(--accent)}
details.more{margin-top:6px}details.more>summary{color:var(--accent);font-size:14px}
label.opt{display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid var(--line);border-radius:8px;margin:8px 0;min-height:44px}
label.comment{display:block;margin:10px 0 0;font-size:13px;color:var(--muted)}
textarea{width:100%;min-height:96px;font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);margin-top:6px}
textarea.overall{min-height:120px}
button{width:100%;padding:14px;font-size:17px;border:0;border-radius:10px;background:var(--accent);color:#fff;margin-top:12px;min-height:48px}
.state{border-left:4px solid var(--accent)}.state.ok{border-left-color:var(--ok)}.state.warn{border-left-color:var(--warn)}.state.bad{border-left-color:var(--bad)}
@media (min-width:640px){.files{flex-direction:row;flex-wrap:wrap}.files a{flex:1 1 240px}}
.assets{display:flex;flex-direction:column;gap:12px;margin-top:8px}figure{margin:0}figure img,figure video{display:block;max-width:100%;height:auto;border-radius:6px;border:1px solid var(--line);background:var(--bg)}
figcaption{font-size:13px;color:var(--muted);margin-top:4px;word-break:break-all}.wait{border-left:4px solid var(--warn)}
`

function layout(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`
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

export function diffHTML(diffs: ReadonlyArray<FileDiff>, formID = "review") {
  if (diffs.length === 0) return `<p class="muted">本轮没有文件改动。</p>`
  let budget = TOTAL_LIMIT
  const additions = diffs.reduce((sum, diff) => sum + diff.additions, 0)
  const deletions = diffs.reduce((sum, diff) => sum + diff.deletions, 0)
  const toc = diffs
    .map(
      (diff, index) =>
        `<a href="#f-${index}"><span class="name">${escape(diff.file)}</span><span><span class="add">+${diff.additions}</span> <span class="del">-${diff.deletions}</span></span></a>`,
    )
    .join("")
  const files = diffs.map((diff, index) => {
    const clipped = diff.patch.length > PATCH_LIMIT || diff.patch.length > budget
    const patch = diff.patch.slice(0, Math.max(0, Math.min(PATCH_LIMIT, budget)))
    budget -= patch.length
    const open = diffs.length === 1 ? " open" : ""
    return `<details class="file" id="f-${index}"${open}><summary>${escape(diff.file)} <span class="add">+${diff.additions}</span> <span class="del">-${diff.deletions}</span> <span class="muted">${escape(diff.status)}</span></summary>${patchBlock(patch, clipped)}<label class="comment">对这个文件的意见（可选）<input type="hidden" name="file-${index}" value="${escape(diff.file)}" form="${escape(formID)}"><textarea name="comment-${index}" form="${escape(formID)}" placeholder="只针对 ${escape(diff.file)} 的意见，会和总体意见一起提交"></textarea></label></details>`
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
  return `<section class="card" aria-label="任务背景"><h2>任务背景</h2>
<p><strong>会话</strong> ${escape(title)}</p>
<div class="muted">最初的请求</div>
${request ? `<div class="request">${escape(request)}</div>` : `<p class="muted">没有找到最初的请求。</p>`}
<div class="muted" style="margin-top:10px">最近对话</div>
${turns}</section>`
}

/** Where the page loads a snapshotted file: the token rides in the path so a custom page's relative links work. */
export function assetURL(reviewID: string, token: string, item: string, file: string) {
  const path = file.split("/").map(encodeURIComponent).join("/")
  return `/api/review/${encodeURIComponent(reviewID)}/a/${encodeURIComponent(token)}/${encodeURIComponent(item)}/${path}`
}

function itemHTML(review: ReviewState.Review, token: string, item: ReviewRequest.StoredItem) {
  const url = (file: string) => escape(assetURL(review.id, token, item.id, file))
  const note = item.note ? `<div class="summary">${escape(item.note)}</div>` : ""
  if (item.kind === "custom" && item.custom)
    return `<section class="card"><h2>${escape(item.title)}</h2>${note}<p><a href="${url(item.custom.entry)}" target="_blank" rel="noopener">打开页面</a></p></section>`
  const assets = item.assets
    .map((asset) => {
      const caption = `<figcaption>${escape(asset.label ? `${asset.label} · ${asset.id}` : asset.id)}</figcaption>`
      if (item.kind === "video")
        return `<figure><video controls playsinline preload="metadata" src="${url(asset.stored.file)}"></video>${caption}</figure>`
      const compare = asset.compare
        ? `<details class="more"><summary>对比参考图</summary><img loading="lazy" alt="参考图" src="${url(asset.compare.file)}"></details>`
        : ""
      return `<figure><img loading="lazy" alt="${escape(asset.id)}" src="${url(asset.stored.file)}">${caption}${compare}</figure>`
    })
    .join("")
  return `<section class="card"><h2>${escape(item.title)}</h2>${note}<div class="assets">${assets}</div></section>`
}

export function approval(input: {
  readonly review: ReviewState.Review
  readonly token: string
  readonly diffs: ReadonlyArray<FileDiff>
  readonly diffError?: string
  readonly context?: ReviewContext.Context
}) {
  const review = input.review
  const action = `/api/review/${encodeURIComponent(review.id)}`
  const items = review.request?.items ?? [ReviewRequest.diffItem(review.id)]
  return layout(
    `审查：${review.title}`,
    `<h1>${escape(review.title)}</h1>
<div class="muted">${escape(review.directory)} · 有效期至 ${escape(new Date(review.expiresAt).toLocaleString("zh-CN", { hour12: false }))}</div>
${contextHTML(review, input.context)}
${review.origin === "agent" ? `<section class="card wait"><h2>Agent 的状态</h2><p>${escape(ReviewRequest.describeWait(review.request?.wait, review.createdAt))}</p></section>` : ""}
<section class="card"><h2>本轮摘要</h2><div class="summary">${escape(review.summary)}</div></section>
${items
  .map((item) =>
    item.kind === "diff"
      ? `<section class="card"><h2>改动</h2>${input.diffError ? `<p class="muted">${escape(input.diffError)}</p>` : diffHTML(input.diffs)}</section>`
      : itemHTML(review, input.token, item),
  )
  .join("\n")}
<form id="review" class="card" method="post" action="${escape(action)}">
<input type="hidden" name="t" value="${escape(input.token)}">
<label class="opt"><input type="radio" name="decision" value="continue" checked> 没问题，继续</label>
<label class="opt"><input type="radio" name="decision" value="changes"> 需要修改（在下面写明）</label>
<label class="opt"><input type="radio" name="decision" value="stop"> 先停下，不用继续</label>
<label class="comment">总体意见（可选；选“需要修改”时请填写）
<textarea class="overall" name="text" placeholder="写给 agent 的总体意见。对各文件的意见写在对应改动下面，会一并提交。"></textarea></label>
<button type="submit">提交</button>
</form>`,
  )
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
