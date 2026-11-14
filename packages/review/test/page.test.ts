import { describe, expect, test } from "bun:test"
import { ReviewContext } from "../src/context.js"
import { ReviewFeedback } from "../src/feedback.js"
import { ReviewPage } from "../src/page.js"
import { ReviewState } from "../src/state.js"

const review: ReviewState.Review = {
  id: "r1",
  sessionID: "s1",
  directory: "/repo",
  title: "Fix <bug>",
  summary: "改了 a.ts 与 b.ts",
  tokenHash: "hash",
  marker: 100,
  createdAt: 1_000,
  expiresAt: 1_000 + ReviewState.DEFAULT_TTL,
  status: "open",
}

const diffs: ReviewPage.FileDiff[] = [
  { file: "a.ts", patch: "@@ -1 +1 @@\n-old\n+<new>", additions: 1, deletions: 1, status: "modified" },
  {
    file: "b.ts",
    patch: Array.from({ length: 60 }, (_, index) => (index === 0 ? "@@ -1,60 +1,60 @@" : `+line ${index}`)).join("\n"),
    additions: 59,
    deletions: 0,
    status: "added",
  },
]

describe("task context", () => {
  test("takes the first human request and the last turns, skipping our own feedback", () => {
    const context = ReviewContext.from("Fix login", [
      { type: "system", text: "ignore" },
      { type: "user", text: "请修复 <登录>" },
      {
        type: "assistant",
        content: [
          { type: "text", text: "先看了一下" },
          { type: "reasoning", text: "secret" },
        ],
      },
      { type: "user", text: "再改一下样式", metadata: { source: "goal" } },
      { type: "user", text: "from phone", metadata: { source: ReviewState.FEEDBACK_SOURCE } },
      { type: "assistant", content: [{ type: "text", text: "已经改好" }] },
    ])
    expect(context.title).toBe("Fix login")
    expect(context.request).toBe("请修复 <登录>")
    expect(context.recent).toEqual([
      { role: "user", text: "请修复 <登录>" },
      { role: "assistant", text: "先看了一下" },
      { role: "user", text: "再改一下样式" },
      { role: "assistant", text: "已经改好" },
    ])
  })
})

describe("approval page", () => {
  const html = () =>
    ReviewPage.approval({
      review,
      token: "tok&en",
      diffs,
      context: {
        title: "Fix <bug>",
        request: "请修复 <登录>",
        recent: [
          { role: "user", text: "请修复 <登录>" },
          { role: "assistant", text: "已经改好" },
        ],
      },
    })

  test("renders context, summary, file list and escaped diffs", () => {
    const page = html()
    expect(page).toContain("任务背景与摘要")
    expect(page).toContain("最初的请求")
    expect(page).toContain("请修复 &lt;登录&gt;")
    expect(page).toContain("最近对话")
    expect(page).toContain("用户")
    expect(page).toContain("助手")
    expect(page).toContain("已经改好")
    expect(page).toContain("本轮摘要")
    expect(page).toContain("改了 a.ts 与 b.ts")
    expect(page).toContain("Fix &lt;bug&gt;")
    expect(page).toContain("2 个文件")
    expect(page).toContain('href="#d-diff-0"')
    expect(page).toContain('id="d-diff-0"')
    expect(page).toContain("a.ts")
    expect(page).toContain("+1")
    expect(page).toContain("-1")
    expect(page).toContain("+&lt;new&gt;")
    expect(page).not.toContain("<new>")
    expect(page).toContain('data-decision="changes"')
    expect(page).toContain("tok\\u0026en")
  })

  test("truncates a long diff behind 显示全部 and offers a per-file comment", () => {
    const page = html()
    expect(page).toContain("显示全部")
    expect(page).toContain('data-asset="b.ts"')
    expect(page).toContain("对这个文件的意见")
    expect(page).toContain('data-verdict="pass"')
    expect(page).toContain('data-verdict="fail"')
    expect(page).toContain("提交全部")
  })

  test("follows the system color scheme and speaks Chinese by default", () => {
    const page = html()
    expect(page).toContain("prefers-color-scheme:dark")
    expect(page).toContain('lang="zh-CN"')
    expect(page).toContain("没问题，继续")
    expect(page).toContain("需要修改")
    expect(page).toContain("先停下")
    expect(page).toContain("提交全部")
    expect(page).toContain("/api/review/r1/submit")
    expect(page).toContain("opencode.review.draft.")
    expect(page).toContain("min-width:900px")
    expect(page).toContain("visualViewport")
  })

  test("keeps a short patch visible without 显示全部", () => {
    const page = ReviewPage.diffHTML([diffs[0]])
    expect(page).not.toContain("显示全部")
    expect(page).not.toContain("本轮没有文件改动。")
    expect(page).toContain("+&lt;new&gt;")
  })
})

describe("approval shell", () => {
  const stored = (file: string, mime: string) => ({
    file,
    mime,
    size: 8,
    sha256: "abc",
    source: file,
  })
  const request = {
    items: [
      {
        id: "shots",
        kind: "image" as const,
        title: "Renders",
        note: "看灯光",
        bundle: "r1",
        feedback: { annotate: true, verdict: true, required: true, checks: [{ id: "shadow", label: "阴影正确" }] },
        assets: [
          {
            id: "far",
            label: "远景",
            stored: stored("far.png", "image/png"),
            compare: stored("far.compare.png", "image/png"),
          },
          { id: "near", label: "近景", stored: stored("near.png", "image/png") },
        ],
      },
      {
        id: "clip",
        kind: "video" as const,
        title: "Clip",
        bundle: "r1",
        feedback: { verdict: true },
        assets: [{ id: "c", stored: stored("c.mp4", "video/mp4"), fps: 30 }],
      },
      {
        id: "diff",
        kind: "diff" as const,
        title: "代码改动",
        bundle: "r1",
        feedback: { verdict: true, annotate: true },
        assets: [],
        diff: { files: ["a.ts"] },
      },
      {
        id: "ui",
        kind: "custom" as const,
        title: "设置页",
        bundle: "r1",
        feedback: { required: true },
        assets: [],
        custom: { entry: "index.html", files: [] },
      },
    ],
    wait: { mode: "block" as const },
  }
  const page = ReviewPage.approval({
    review: { ...review, origin: "agent", request },
    token: "tok&en",
    diffs,
  })

  test("lists every item, annotates images, and keeps video view-only", () => {
    expect(page).toContain('data-go="shots"')
    expect(page).toContain('data-go="clip"')
    expect(page).toContain('data-go="diff"')
    expect(page).toContain('data-go="ui"')
    expect(page).toContain("第 1/4 项")
    expect(page).toContain('data-asset-go="far"')
    expect(page).toContain('data-asset-go="near"')
    expect(page).toContain("/api/review/r1/a/tok%26en/shots/far.png")
    expect(page).toContain("/api/review/r1/annotator?t=tok%26en")
    expect(page).toContain('data-annotator')
    expect(page).toContain("对比参考图")
    expect(page).toContain("<video")
    expect(page).not.toContain("requestVideoFrameCallback")
    expect(page).toContain("review-annotator:load")
    const payload = page.split('id="review-data">')[1].split("</script>")[0]
    const data = JSON.parse(payload)
    expect(data.items[0].annotate).toBe(true)
    expect(data.items[0].sources.far).toContain("/api/review/r1/a/tok%26en/shots/far.png")
    expect(data.items[1].annotate).toBeUndefined()
  })

  test("uses the annotator for a video item that asks for marks, and leaves others view-only", () => {
    const videoReview = {
      ...review,
      origin: "agent" as const,
      request: {
        items: [
          {
            id: "clip",
            kind: "video" as const,
            title: "Clip",
            bundle: "r1",
            feedback: { annotate: true, verdict: true },
            assets: [{ id: "c", stored: stored("c.mp4", "video/mp4"), fps: 24 }],
          },
          {
            id: "plain",
            kind: "video" as const,
            title: "Plain",
            bundle: "r1",
            feedback: { verdict: true },
            assets: [{ id: "p", stored: stored("p.mp4", "video/mp4") }],
          },
        ],
        wait: { mode: "async" as const },
      },
    }
    const html = ReviewPage.approval({ review: videoReview, token: "tok", diffs: [] })
    expect(html).toContain('data-annotator')
    expect(html).toContain("/api/review/r1/annotator?t=tok")
    expect(html).toContain("/api/review/r1/a/tok/clip/c.mp4")
    expect(html).toContain("<video")
    expect(html).toContain("/api/review/r1/a/tok/plain/p.mp4")
    const payload = JSON.parse(html.split('id="review-data">')[1].split("</script>")[0])
    expect(payload.items[0].annotate).toBe(true)
    expect(payload.items[0].sources.c).toContain("/api/review/r1/a/tok/clip/c.mp4")
    expect(payload.items[0].fps.c).toBe(24)
    expect(payload.items[1].annotate).toBeUndefined()
    expect(html).toContain("review-annotator:load")
  })

  test("migrates the diff with per-file verdicts and honors a file filter", () => {
    expect(page).toContain('id="d-diff-0"')
    expect(page).toContain('data-asset="a.ts"')
    expect(page).not.toContain('data-asset="b.ts"')
    expect(page).toContain("对这个文件的意见")
  })

  test("shows pass/fail, checkpoints, a sandboxed custom page, and the JSON submit", () => {
    expect(page).toContain("阴影正确")
    expect(page).toContain('data-check="shadow"')
    expect(page).toContain("本项结论")
    expect(page).toContain('sandbox="allow-scripts allow-forms"')
    expect(page).toContain('data-custom')
    expect(page).toContain("opencode-review:hello")
    expect(page).toContain("opencode-review:result")
    expect(page).toContain("/api/review/r1/a/tok%26en/ui/index.html")
    expect(page).toContain("/api/review/r1/submit")
    expect(page).toContain("正在等你的反馈")
    const payload = page.split('id="review-data">')[1].split("</script>")[0]
    expect(payload).toContain("tok\\u0026en")
    expect(JSON.parse(payload).token).toBe("tok&en")
  })
})

describe("json embedding", () => {
  test("escapes angle brackets and ampersands so a title cannot break out of the script", () => {
    const encoded = ReviewPage.jsonScript({ token: "tok&en", title: "</script><b>x</b>" })
    expect(encoded).toContain("\\u003c")
    expect(encoded).toContain("\\u0026")
    expect(encoded).not.toContain("</script>")
    expect(encoded).not.toContain("<b>")
  })
})

describe("page states", () => {
  test("expired, already submitted, already continued, success and failure are distinct", () => {
    expect(ReviewPage.outcome("expired")).toEqual(
      expect.objectContaining({
        status: 410,
      }),
    )
    expect(ReviewPage.outcome("expired").html).toContain("链接已过期")
    expect(ReviewPage.outcome("expired").html).toContain("state warn")
    expect(ReviewPage.outcome("used").status).toBe(409)
    expect(ReviewPage.outcome("used").html).toContain("已经提交过")
    expect(ReviewPage.outcome("continued").html).toContain("已在电脑端继续")
    expect(ReviewPage.outcome("invalid").status).toBe(404)
    expect(ReviewPage.submitted("continue")).toContain("已提交")
    expect(ReviewPage.submitted("continue")).toContain("已通知 agent 继续")
    expect(ReviewPage.submitted("continue")).toContain("state ok")
    expect(ReviewPage.submitted("changes")).toContain("已把修改意见发给 agent")
    expect(ReviewPage.submitted("stop")).toContain("已记录：先停下")
    expect(ReviewPage.failed().status).toBe(502)
    expect(ReviewPage.failed().html).toContain("提交失败")
    expect(ReviewPage.failed().html).toContain("state bad")
  })
})

describe("feedback formatting", () => {
  test("batches an overall note with per-file comments", () => {
    const text = ReviewFeedback.prompt("changes", "rename foo", [
      { file: "a.ts", text: "this function is unused" },
      { file: "b.ts", text: "  missing null check  " },
      { file: "c.ts", text: "   " },
    ])
    expect(text).toBe(
      [
        "[Remote review] I reviewed your work from my phone and request these changes:",
        "",
        "rename foo",
        "",
        "Comments:",
        "- a.ts:",
        "  this function is unused",
        "- b.ts:",
        "  missing null check",
      ].join("\n"),
    )
  })

  test("continues with optional note and comments, and skips a prompt on stop", () => {
    expect(ReviewFeedback.prompt("continue", undefined)).toBe(
      "[Remote review] I reviewed your work from my phone. Looks good, please continue.",
    )
    expect(ReviewFeedback.prompt("continue", "ship it", [{ file: "a.ts", text: "nits later" }])).toBe(
      [
        "[Remote review] I reviewed your work from my phone. Looks good, please continue.",
        "",
        "Note:",
        "ship it",
        "",
        "Comments:",
        "- a.ts:",
        "  nits later",
      ].join("\n"),
    )
    expect(ReviewFeedback.prompt("stop", "later", [{ file: "a.ts", text: "nits" }])).toBeUndefined()
  })

  test("reads indexed form fields and ignores empty comments", () => {
    const form = new URLSearchParams({
      "file-0": "a.ts",
      "comment-0": " unused ",
      "file-1": "b.ts",
      "comment-1": "",
      "file-2": "c.ts",
      "comment-2": "add tests",
    })
    expect(ReviewFeedback.fromForm(form)).toEqual([
      { file: "a.ts", text: "unused" },
      { file: "c.ts", text: "add tests" },
    ])
  })
})
