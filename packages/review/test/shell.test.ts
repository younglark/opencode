import { describe, expect, test } from "bun:test"
import { ReviewForm } from "../src/form.js"
import { ReviewShell } from "../src/shell.js"

const shots: ReviewShell.ItemInfo = {
  id: "shots",
  kind: "image",
  title: "Renders",
  feedback: {
    form: [
      ReviewForm.verdictChoice(),
      {
        id: "checks",
        type: "multi",
        label: "还需要看",
        options: [{ id: "shadow", label: "阴影正确" }],
      },
      {
        id: "comment",
        type: "text",
        label: "意见",
        required: true,
        when: { field: "verdict", equals: "fail" },
      },
    ],
  },
  assetIDs: ["far", "near"],
}
const clip: ReviewShell.ItemInfo = {
  id: "clip",
  kind: "video",
  title: "Clip",
  feedback: {
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
    ],
  },
  assetIDs: ["c"],
}
const notes: ReviewShell.ItemInfo = {
  id: "notes",
  kind: "custom",
  title: "设置页",
  feedback: {
    form: [{ id: "note", type: "text", label: "补充说明", placeholder: "可选" }],
  },
  assetIDs: [],
}

const items = [shots, clip, notes]

describe("draft", () => {
  test("ignores missing, garbled or version-mismatched storage", () => {
    expect(ReviewShell.parse(undefined)).toEqual(ReviewShell.empty())
    expect(ReviewShell.parse("{")).toEqual(ReviewShell.empty())
    expect(ReviewShell.parse(JSON.stringify({ v: 2, decision: "changes" }))).toEqual(ReviewShell.empty())
    expect(ReviewShell.parse(JSON.stringify({ v: 1, decision: "maybe" }))).toEqual(ReviewShell.empty())
  })

  test("round-trips a valid draft, including form answers and a drawer toggle", () => {
    const draft: ReviewShell.Draft = {
      v: 1,
      decision: "changes",
      text: "整体偏暗",
      item: "shots",
      asset: { shots: "near" },
      seen: { shots: true },
      drawer: { shots: "open" },
      items: { shots: { answers: { verdict: "fail", comment: "阴影反了" } } },
    }
    expect(ReviewShell.parse(JSON.stringify(draft))).toEqual(draft)
    expect(ReviewShell.key("r1")).toBe("opencode.review.draft.r1")
  })
})

describe("status and required items", () => {
  test("is unread until opened, open once seen, and follows a natural pass/fail answer", () => {
    const draft = ReviewShell.empty()
    expect(ReviewShell.status(shots, draft)).toBe("unread")
    expect(ReviewShell.itemVerdict(shots, draft)).toBeUndefined()
    draft.seen = { shots: true }
    expect(ReviewShell.status(shots, draft)).toBe("open")
    draft.items = { shots: { answers: { verdict: "pass" } } }
    expect(ReviewShell.itemVerdict(shots, draft)).toBe("pass")
    expect(ReviewShell.status(shots, draft)).toBe("pass")
    draft.items.shots.answers = { verdict: "fail" }
    expect(ReviewShell.itemVerdict(shots, draft)).toBe("fail")
    expect(ReviewShell.status(shots, draft)).toBe("fail")
  })

  test("a custom bridge verdict still counts, and a non-pass/fail choice does not", () => {
    const draft: ReviewShell.Draft = {
      v: 1,
      decision: "continue",
      items: {
        notes: { verdict: "fail" },
        clip: { answers: { feel: "smooth" } },
      },
    }
    expect(ReviewShell.itemVerdict(notes, draft)).toBe("fail")
    expect(ReviewShell.status(notes, draft)).toBe("fail")
    expect(ReviewShell.itemVerdict(clip, draft)).toBeUndefined()
    expect(ReviewShell.status(clip, draft)).toBe("open")
  })

  test("required gaps honor when; optional items count as done once seen", () => {
    const draft = ReviewShell.empty()
    expect(ReviewShell.missing(items, draft).map((item) => item.id)).toEqual(["shots", "clip"])
    expect(ReviewShell.completed(items, draft)).toBe(0)
    draft.seen = { notes: true }
    expect(ReviewShell.completed(items, draft)).toBe(1)
    draft.items = { shots: { answers: { verdict: "fail" } } }
    expect(ReviewShell.missing(items, draft).map((item) => item.id)).toEqual(["shots", "clip"])
    draft.items.shots.answers = { verdict: "fail", comment: "阴影反了" }
    expect(ReviewShell.missing(items, draft).map((item) => item.id)).toEqual(["clip"])
    draft.items.shots.answers = { verdict: "pass" }
    draft.items.clip = { answers: { feel: "smooth" } }
    expect(ReviewShell.missing(items, draft)).toEqual([])
    expect(ReviewShell.completed(items, draft)).toBe(3)
  })
})

describe("submission", () => {
  test("drops empty entries and keeps structured answers plus annotations", () => {
    const marks = [{ n: 1, shape: "rect" as const, rect: { x1: 10, y1: 20, x2: 80, y2: 90 }, text: "阴影反了" }]
    const draft: ReviewShell.Draft = {
      v: 1,
      decision: "changes",
      text: "  整体再亮一点  ",
      items: {
        shots: {
          answers: { verdict: "fail", checks: ["shadow"], comment: " 远景不行 " },
          assets: { far: { annotations: marks }, near: {} },
        },
        clip: { assets: { c: {} } },
        notes: { answers: { note: "  " } },
      },
    }
    expect(ReviewShell.toSubmission(items, draft)).toEqual({
      decision: "changes",
      text: "整体再亮一点",
      items: [
        {
          id: "shots",
          answers: { verdict: "fail", checks: ["shadow"], comment: "远景不行" },
          assets: [{ asset: "far", annotations: marks }],
        },
      ],
    })
  })

  test("keeps annotation marks and raw overlay data in the submission and treats them as input", () => {
    const marks = [{ n: 1, shape: "rect" as const, rect: { x1: 10, y1: 20, x2: 80, y2: 90 }, text: "阴影反了" }]
    const raw = { schemaVersion: "feedback-minimal-4", objects: [] }
    const draft: ReviewShell.Draft = {
      v: 1,
      decision: "changes",
      items: {
        shots: { assets: { far: { annotations: marks, raw } } },
      },
    }
    expect(ReviewShell.status(shots, draft)).toBe("open")
    expect(ReviewShell.toSubmission(items, draft)).toEqual({
      decision: "changes",
      items: [{ id: "shots", assets: [{ asset: "far", annotations: marks, raw }] }],
    })
  })

  test("keeps video frame annotations and raw overlay data in the submission", () => {
    const marks = [
      {
        n: 1,
        shape: "rect" as const,
        rect: { x1: 10, y1: 20, x2: 80, y2: 90 },
        text: "拖尾断开",
        frame: { timeMs: 3200, timeUs: 3_200_000, index: 96 },
      },
    ]
    const raw = { schemaVersion: "video-feedback-1", frames: [], fps: 30 }
    const draft: ReviewShell.Draft = {
      v: 1,
      decision: "changes",
      items: { clip: { assets: { c: { annotations: marks, raw, files: ["clip-c-f96.annotated.png"] } } } },
    }
    expect(ReviewShell.status(clip, draft)).toBe("open")
    expect(ReviewShell.toSubmission(items, draft)).toEqual({
      decision: "changes",
      items: [
        {
          id: "clip",
          assets: [{ asset: "c", annotations: marks, raw, files: ["clip-c-f96.annotated.png"] }],
        },
      ],
    })
  })

  test("keeps a custom page payload, bridge verdict and text in the draft and the submission", () => {
    const custom = { volume: 0.8, preset: "night" }
    const draft: ReviewShell.Draft = {
      v: 1,
      decision: "changes",
      items: { notes: { verdict: "fail", text: "横屏被挡住", custom } },
    }
    expect(ReviewShell.status(notes, draft)).toBe("fail")
    expect(ReviewShell.toSubmission(items, draft)).toEqual({
      decision: "changes",
      items: [{ id: "notes", verdict: "fail", text: "横屏被挡住", custom }],
    })
    const only: ReviewShell.Draft = { v: 1, decision: "continue", items: { notes: { custom } } }
    expect(ReviewShell.status(notes, only)).toBe("open")
    expect(ReviewShell.toSubmission(items, only)).toEqual({
      decision: "continue",
      items: [{ id: "notes", custom }],
    })
  })

  test("suggests changes when a natural fail is set, continue when every judged item passed, and keeps stop", () => {
    const draft: ReviewShell.Draft = { v: 1, decision: "continue", items: { shots: { answers: { verdict: "fail" } } } }
    expect(ReviewShell.suggest(items, draft)).toBe("changes")
    draft.items = {
      shots: { answers: { verdict: "pass" } },
      notes: { verdict: "pass" },
    }
    expect(ReviewShell.suggest(items, draft)).toBe("continue")
    draft.decision = "stop"
    expect(ReviewShell.suggest(items, draft)).toBe("stop")
  })
})
