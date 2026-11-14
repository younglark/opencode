import { describe, expect, test } from "bun:test"
import { ReviewForm } from "../src/form.js"

const verdict = ReviewForm.verdictChoice()
const comment: ReviewForm.Field = {
  id: "comment",
  type: "text",
  label: "意见",
  required: true,
  placeholder: "请说明要改什么",
  when: { field: "verdict", equals: "fail" },
}
const checks: ReviewForm.Field = {
  id: "checks",
  type: "multi",
  label: "还需要看",
  options: [
    { id: "shadow", label: "阴影方向" },
    { id: "ground", label: "地面亮度" },
  ],
}
const feel: ReviewForm.Field = {
  id: "feel",
  type: "choice",
  label: "观感",
  required: true,
  options: [
    { id: "smooth", label: "流畅" },
    { id: "stutter", label: "卡顿" },
    { id: "again", label: "再看一遍" },
  ],
}
const merge: ReviewForm.Field = {
  id: "merge",
  type: "choice",
  label: "这次改动",
  required: true,
  options: [
    { id: "ok", label: "可以合入" },
    { id: "rework", label: "需要再改" },
  ],
}

const form = [verdict, checks, comment]

describe("visibility and required gaps", () => {
  test("a when field is hidden until the other field matches, and is required only then", () => {
    expect(ReviewForm.visible(comment, undefined)).toBe(false)
    expect(ReviewForm.visible(comment, { verdict: "pass" })).toBe(false)
    expect(ReviewForm.visible(comment, { verdict: "fail" })).toBe(true)
    expect(ReviewForm.missing(form, undefined).map((field) => field.id)).toEqual(["verdict"])
    expect(ReviewForm.missing(form, { verdict: "pass" })).toEqual([])
    expect(ReviewForm.missing(form, { verdict: "fail" }).map((field) => field.id)).toEqual(["comment"])
    expect(ReviewForm.missing(form, { verdict: "fail", comment: "  " }).map((field) => field.id)).toEqual(["comment"])
    expect(ReviewForm.missing(form, { verdict: "fail", comment: "阴影反了" })).toEqual([])
  })

  test("when.equals accepts a list, and a multi field matches if any selected value is listed", () => {
    const note: ReviewForm.Field = {
      id: "note",
      type: "text",
      label: "补充",
      required: true,
      when: { field: "checks", equals: ["shadow", "ground"] },
    }
    expect(ReviewForm.visible(note, { checks: ["shadow"] })).toBe(true)
    expect(ReviewForm.visible(note, { checks: ["other"] })).toBe(false)
    expect(ReviewForm.visible(note, { checks: "shadow" })).toBe(true)
  })
})

describe("pass/fail shortcuts", () => {
  test("detects a natural pass/fail choice and maps P/F to option ids", () => {
    expect(ReviewForm.isPassFail(verdict)).toBe(true)
    expect(ReviewForm.isPassFail(feel)).toBe(false)
    expect(ReviewForm.isPassFail(merge)).toBe(false)
    expect(ReviewForm.passFailField(form, undefined)?.id).toBe("verdict")
    expect(ReviewForm.optionFor(verdict, "pass")).toBe("pass")
    expect(ReviewForm.optionFor(verdict, "fail")).toBe("fail")
    expect(ReviewForm.polarityOf(verdict, { verdict: "fail" })).toBe("fail")
    expect(ReviewForm.itemPolarity(form, { verdict: "pass" })).toBe("pass")
  })

  test("P/F falls back to the only required two-option choice, but that does not count as a verdict", () => {
    expect(ReviewForm.passFailField([feel], undefined)).toBeUndefined()
    expect(ReviewForm.passFailField([merge], undefined)?.id).toBe("merge")
    expect(ReviewForm.optionFor(merge, "pass")).toBe("ok")
    expect(ReviewForm.optionFor(merge, "fail")).toBe("rework")
    expect(ReviewForm.polarityOf(merge, { merge: "ok" })).toBeUndefined()
    expect(ReviewForm.itemPolarity([merge], { merge: "ok" })).toBeUndefined()
  })

  test("a hidden pass/fail field is not the P/F target", () => {
    const later: ReviewForm.Field = { ...verdict, id: "later", when: { field: "feel", equals: "stutter" } }
    expect(ReviewForm.passFailField([feel, later], { feel: "smooth" })).toBeUndefined()
    expect(ReviewForm.passFailField([feel, later], { feel: "stutter" })?.id).toBe("later")
  })
})

describe("sanitize and format", () => {
  test("keeps known visible answers, clips text, and drops hidden or unknown values", () => {
    expect(
      ReviewForm.sanitize(
        form,
        {
          verdict: "fail",
          checks: ["shadow", "shadow", "ghost"],
          comment: "  灯光偏暗  ",
          extra: "nope",
        },
        8_000,
      ),
    ).toEqual({
      verdict: "fail",
      checks: ["shadow"],
      comment: "灯光偏暗",
    })
    expect(ReviewForm.sanitize(form, { verdict: "pass", comment: "should hide", checks: [] }, 8_000)).toEqual({
      verdict: "pass",
    })
    expect(ReviewForm.sanitize(form, { verdict: "maybe", comment: "" }, 8_000)).toBeUndefined()
    expect(ReviewForm.format(form, { verdict: "fail", checks: ["shadow", "ground"], comment: "改一下" })).toEqual([
      "结论: 不通过",
      "还需要看: 阴影方向、地面亮度",
      "意见: 改一下",
    ])
  })
})

describe("schema validation", () => {
  test("reports duplicate ids, missing options, and a bad when reference", () => {
    const errors = ReviewForm.validate(
      [
        { id: "verdict", type: "choice", label: "结论" },
        { id: "verdict", type: "text", label: "重复", options: [{ id: "x", label: "X" }] },
        { id: "note", type: "text", label: "意见", when: { field: "missing", equals: "fail" } },
        { id: "self", type: "text", label: "自己", when: { field: "self", equals: "x" } },
        { id: "bad id", type: "multi", label: "多选", options: [{ id: "a", label: "" }, { id: "a", label: "A" }] },
      ],
      "items[0]",
    )
    expect(errors.some((error) => error.includes("choice needs options"))).toBe(true)
    expect(errors.some((error) => error.includes('"verdict" is used twice'))).toBe(true)
    expect(errors.some((error) => error.includes("text takes no options"))).toBe(true)
    expect(errors.some((error) => error.includes('when.field "missing" does not exist'))).toBe(true)
    expect(errors.some((error) => error.includes("when cannot refer to itself"))).toBe(true)
    expect(errors.some((error) => error.includes("id must match"))).toBe(true)
    expect(errors.some((error) => error.includes("options[0].label is empty"))).toBe(true)
    expect(errors.some((error) => error.includes('"a" is used twice'))).toBe(true)
  })

  test("accepts a well-formed form", () => {
    expect(ReviewForm.validate(form, "items[0]")).toEqual([])
  })
})
