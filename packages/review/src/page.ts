export * as ReviewPage from "./page.js"

import type { ReviewDecide } from "./decide.js"
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

export function escape(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

const STYLE = `
:root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--bg:#fff;--card:#f6f8fa;--line:#d1d9e0;--add:#1a7f37;--del:#cf222e;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--card:#151b23;--line:#3d444d;--add:#3fb950;--del:#f85149;--accent:#4493f8}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:860px;margin:0 auto;padding:16px}h1{font-size:20px;margin:4px 0 2px}.muted{color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0}
.summary{white-space:pre-wrap}details{border-top:1px solid var(--line);padding:8px 0}details:first-of-type{border-top:0}
summary{cursor:pointer;word-break:break-all}.add{color:var(--add)}.del{color:var(--del)}
pre{overflow:auto;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;margin:8px 0 0;padding:8px;background:var(--bg);border-radius:6px}
pre .a{color:var(--add)}pre .d{color:var(--del)}pre .h{color:var(--accent)}
label.opt{display:flex;gap:10px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:8px;margin:8px 0}
textarea{width:100%;min-height:120px;font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
button{width:100%;padding:14px;font-size:17px;border:0;border-radius:10px;background:var(--accent);color:#fff;margin-top:8px}
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

export function diffHTML(diffs: ReadonlyArray<FileDiff>) {
  if (diffs.length === 0) return `<p class="muted">本轮没有文件改动。</p>`
  let budget = TOTAL_LIMIT
  const additions = diffs.reduce((sum, diff) => sum + diff.additions, 0)
  const deletions = diffs.reduce((sum, diff) => sum + diff.deletions, 0)
  const files = diffs.map((diff) => {
    const clipped = diff.patch.length > PATCH_LIMIT || diff.patch.length > budget
    const patch = diff.patch.slice(0, Math.max(0, Math.min(PATCH_LIMIT, budget)))
    budget -= patch.length
    return `<details><summary>${escape(diff.file)} <span class="add">+${diff.additions}</span> <span class="del">-${diff.deletions}</span> <span class="muted">${escape(diff.status)}</span></summary><pre>${patchHTML(patch)}${clipped ? "\n…（已截断）" : ""}</pre></details>`
  })
  return `<p class="muted">${diffs.length} 个文件 <span class="add">+${additions}</span> <span class="del">-${deletions}</span></p>${files.join("")}`
}

export function approval(input: {
  readonly review: ReviewState.Review
  readonly token: string
  readonly diffs: ReadonlyArray<FileDiff>
  readonly diffError?: string
}) {
  const review = input.review
  const action = `/api/review/${encodeURIComponent(review.id)}`
  return layout(
    `审查：${review.title}`,
    `<h1>${escape(review.title)}</h1>
<div class="muted">${escape(review.directory)} · 有效期至 ${escape(new Date(review.expiresAt).toLocaleString("zh-CN", { hour12: false }))}</div>
<section class="card"><div class="muted">本轮摘要</div><div class="summary">${escape(review.summary)}</div></section>
<section class="card"><div class="muted">改动</div>${input.diffError ? `<p class="muted">${escape(input.diffError)}</p>` : diffHTML(input.diffs)}</section>
<form class="card" method="post" action="${escape(action)}">
<input type="hidden" name="t" value="${escape(input.token)}">
<label class="opt"><input type="radio" name="decision" value="continue" checked> 没问题，继续</label>
<label class="opt"><input type="radio" name="decision" value="changes"> 需要修改（在下面写明）</label>
<label class="opt"><input type="radio" name="decision" value="stop"> 先停下，不用继续</label>
<textarea name="text" placeholder="写给 agent 的意见（可选；选“需要修改”时请填写）"></textarea>
<button type="submit">提交</button>
</form>`,
  )
}

const MESSAGES: Record<Exclude<ReviewDecide.Outcome, "ok">, { title: string; body: string; status: number }> = {
  invalid: { title: "链接无效", body: "这个审查链接无效或已被替换。", status: 404 },
  used: { title: "已经提交过", body: "这个审查链接已经提交过，不能重复使用。", status: 409 },
  expired: {
    title: "链接已过期",
    body: "这个审查链接已过期。回到电脑上继续，或在会话里运行 /review-remote now 重新发送。",
    status: 410,
  },
  continued: {
    title: "已在电脑端继续",
    body: "这个会话在你打开链接之后已经在电脑上继续了，手机端的反馈不会再写回。",
    status: 409,
  },
}

export function outcome(kind: Exclude<ReviewDecide.Outcome, "ok">) {
  const message = MESSAGES[kind]
  return { status: message.status, html: layout(message.title, `<h1>${message.title}</h1><p>${message.body}</p>`) }
}

export function submitted(decision: ReviewState.Decision) {
  const body =
    decision === "stop"
      ? "已记录：先停下。会话保持空闲，回到电脑后再处理。"
      : decision === "changes"
        ? "已把修改意见发给 agent，它会接着改。"
        : "已通知 agent 继续。"
  return layout("已提交", `<h1>已提交</h1><p>${body}</p>`)
}

export function failed() {
  return { status: 502, html: layout("提交失败", "<h1>提交失败</h1><p>反馈没能写回会话，请稍后重试。</p>") }
}
