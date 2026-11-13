import { describe, expect, test } from "bun:test"
import { ReviewDecide } from "../src/decide.js"
import { ReviewFeedback } from "../src/feedback.js"
import { ReviewInbox } from "../src/inbox.js"
import { ReviewState } from "../src/state.js"
import { ReviewToken } from "../src/token.js"

describe("token", () => {
  test("is 32 random bytes and only its hash is compared", () => {
    const token = ReviewToken.generate()
    expect(Buffer.from(token, "base64url")).toHaveLength(32)
    expect(ReviewToken.generate()).not.toBe(token)
    const hash = ReviewToken.hash(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(ReviewToken.matches(token, hash)).toBe(true)
    expect(ReviewToken.matches(token + "x", hash)).toBe(false)
    expect(ReviewToken.matches(undefined, hash)).toBe(false)
  })
})

describe("decide", () => {
  const token = ReviewToken.generate()
  const review: ReviewState.Review = {
    id: "r1",
    sessionID: "s1",
    directory: "/repo",
    title: "t",
    summary: "s",
    tokenHash: ReviewToken.hash(token),
    marker: 100,
    createdAt: 1_000,
    expiresAt: 10_000,
    status: "open",
  }
  const idle = { busy: 100, idle: 200 }

  test("accepts a fresh link on an unchanged session", () => {
    expect(ReviewDecide.check({ review, token, now: 2_000, session: idle })).toBe("ok")
  })
  test("rejects a wrong token, a missing review or session", () => {
    expect(ReviewDecide.check({ review, token: "nope", now: 2_000, session: idle })).toBe("invalid")
    expect(ReviewDecide.check({ review: undefined, token, now: 2_000, session: idle })).toBe("invalid")
    expect(ReviewDecide.check({ review, token, now: 2_000, session: undefined })).toBe("invalid")
  })
  test("is one-time and expires", () => {
    expect(ReviewDecide.check({ review: { ...review, status: "submitted" }, token, now: 2_000, session: idle })).toBe(
      "used",
    )
    expect(ReviewDecide.check({ review, token, now: 10_000, session: idle })).toBe("expired")
  })
  test("rejects once the desktop continued the session", () => {
    // A newer execution started.
    expect(ReviewDecide.check({ review, token, now: 2_000, session: { busy: 300, idle: 400 } })).toBe("continued")
    // One is running right now.
    expect(ReviewDecide.check({ review, token, now: 2_000, session: { busy: 100, idle: 50 } })).toBe("continued")
    // The plugin saw new input first.
    expect(ReviewDecide.check({ review: { ...review, status: "superseded" }, token, now: 2_000, session: idle })).toBe(
      "continued",
    )
  })
})

describe("inbox filtering", () => {
  test("counts only typed user input", () => {
    expect(ReviewInbox.isHumanInput({ type: "user", payload: { text: "hi" } })).toBe(true)
    expect(ReviewInbox.isHumanInput({ type: "user", payload: { text: "x", metadata: { source: "goal" } } })).toBe(true)
    expect(
      ReviewInbox.isHumanInput({
        type: "user",
        payload: { text: "x", metadata: ReviewFeedback.metadata("r", "continue") },
      }),
    ).toBe(false)
    expect(ReviewInbox.isHumanInput({ type: "synthetic", payload: { text: "notice" } })).toBe(false)
    expect(ReviewInbox.isHumanInput({ type: "compaction", payload: {} })).toBe(false)
    expect(ReviewInbox.isHumanInput({ type: "move", payload: {} })).toBe(false)
  })
})

describe("feedback", () => {
  test("renders a prompt per decision", () => {
    expect(ReviewFeedback.prompt("stop", "x")).toBeUndefined()
    expect(ReviewFeedback.prompt("continue", "")).toContain("please continue")
    expect(ReviewFeedback.prompt("changes", "rename foo")).toContain("rename foo")
  })
})
