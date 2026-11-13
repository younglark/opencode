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
    expect(page).toContain("任务背景")
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
    expect(page).toContain('href="#f-0"')
    expect(page).toContain('id="f-0"')
    expect(page).toContain("a.ts")
    expect(page).toContain("+1")
    expect(page).toContain("-1")
    expect(page).toContain("+&lt;new&gt;")
    expect(page).not.toContain("<new>")
    expect(page).toContain('name="decision" value="changes"')
    expect(page).toContain('value="tok&amp;en"')
  })

  test("truncates a long diff behind 显示全部 and offers a per-file comment", () => {
    const page = html()
    expect(page).toContain("显示全部")
    expect(page).toContain('name="file-0"')
    expect(page).toContain('name="comment-0"')
    expect(page).toContain('name="file-1"')
    expect(page).toContain('name="comment-1"')
    expect(page).toContain('value="b.ts"')
    expect(page).toContain("对这个文件的意见")
    expect(page).toContain('form="review"')
  })

  test("follows the system color scheme and speaks Chinese by default", () => {
    const page = html()
    expect(page).toContain("prefers-color-scheme:dark")
    expect(page).toContain('lang="zh-CN"')
    expect(page).toContain("没问题，继续")
    expect(page).toContain("需要修改")
    expect(page).toContain("先停下")
    expect(page).toContain("提交")
  })

  test("keeps a short patch visible without 显示全部", () => {
    const page = ReviewPage.diffHTML([diffs[0]])
    expect(page).not.toContain("显示全部")
    expect(page).not.toContain("本轮没有文件改动。")
    expect(page).toContain("+&lt;new&gt;")
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
