export * as ReviewShell from "./shell.js"

import type { ReviewRequest } from "./request.js"
import { ReviewForm } from "./form.js"
import { ReviewResult } from "./result.js"
import type { ReviewState } from "./state.js"

export type Verdict = "pass" | "fail"
export type Decision = ReviewState.Decision
export type Status = "unread" | "open" | "pass" | "fail"

export const STATUS_LABEL: Record<Status, string> = {
  unread: "未看",
  open: "已看",
  pass: "通过",
  fail: "不通过",
}

export interface AssetDraft {
  /** Structured marks for this asset; restored after a refresh. */
  annotations?: ReviewResult.Annotation[]
  /** Annotator-native export without embedded images (feedback-minimal-4 or video-feedback-1). */
  raw?: unknown
  /** Snapshot file names to attach on submit. */
  files?: string[]
}

export interface ItemDraft {
  /** Answers to the agent-defined form, keyed by field id. */
  answers?: ReviewForm.Answers
  assets?: { [id: string]: AssetDraft }
  /** Structured payload from a custom page (opencode-review protocol). */
  custom?: unknown
  /** Custom pages may still report a verdict / note through the v1 bridge. */
  verdict?: Verdict
  text?: string
}

export interface Draft {
  v: 1
  decision: Decision
  text?: string
  /** The item the reviewer was last looking at. */
  item?: string
  /** Last asset shown, keyed by item id. */
  asset?: { [item: string]: string }
  seen?: { [item: string]: true }
  items?: { [id: string]: ItemDraft }
  /** Manual feedback-drawer toggle, remembered per item. */
  drawer?: { [item: string]: "open" | "closed" }
}

/** Slim view of a stored item, enough to drive the shell and to build a submission. */
export interface ItemInfo {
  readonly id: string
  readonly kind: ReviewRequest.Kind
  readonly title: string
  readonly feedback?: ReviewRequest.Feedback
  /** Image / video asset ids, or the file paths of a diff item. */
  readonly assetIDs: ReadonlyArray<string>
}

export const key = (reviewID: string) => `opencode.review.draft.${reviewID}`

export function empty(): Draft {
  return { v: 1, decision: "continue" }
}

export function parse(raw: string | null | undefined): Draft {
  if (!raw) return empty()
  try {
    const value = JSON.parse(raw) as Draft
    if (value?.v !== 1) return empty()
    if (value.decision !== "continue" && value.decision !== "changes" && value.decision !== "stop") return empty()
    return value
  } catch {
    return empty()
  }
}

export function itemDraft(draft: Draft, id: string): ItemDraft {
  return draft.items?.[id] ?? {}
}

export function assetDraft(draft: Draft, item: string, asset: string): AssetDraft {
  return itemDraft(draft, item).assets?.[asset] ?? {}
}

export function formOf(item: ItemInfo): ReadonlyArray<ReviewForm.Field> {
  return item.feedback?.form ?? []
}

export function answersOf(item: ItemInfo, draft: Draft): ReviewForm.Answers | undefined {
  return itemDraft(draft, item.id).answers
}

/** A natural pass / fail from the form, or a custom page's bridge verdict. */
export function itemVerdict(item: ItemInfo, draft: Draft): Verdict | undefined {
  const saved = itemDraft(draft, item.id)
  if (saved.verdict === "pass" || saved.verdict === "fail") return saved.verdict
  return ReviewForm.itemPolarity(formOf(item), saved.answers)
}

function hasInput(item: ItemInfo, draft: Draft) {
  const saved = itemDraft(draft, item.id)
  if (saved.verdict || saved.text?.trim() || saved.custom !== undefined) return true
  if (saved.answers && Object.keys(saved.answers).length > 0) return true
  return Object.values(saved.assets ?? {}).some((asset) =>
    Boolean(asset.annotations?.length || asset.raw || asset.files?.length),
  )
}

export function status(item: ItemInfo, draft: Draft): Status {
  const verdict = itemVerdict(item, draft)
  if (verdict) return verdict
  if (draft.seen?.[item.id] || hasInput(item, draft)) return "open"
  return "unread"
}

/** Items with a visible required form field that still has no answer. */
export function missing(items: ReadonlyArray<ItemInfo>, draft: Draft): ReadonlyArray<ItemInfo> {
  return items.filter((item) => ReviewForm.missing(formOf(item), answersOf(item, draft)).length > 0)
}

/** How many items count as done in the progress bar. */
export function completed(items: ReadonlyArray<ItemInfo>, draft: Draft) {
  return items.filter((item) => {
    if (ReviewForm.missing(formOf(item), answersOf(item, draft)).length > 0) return false
    const required = formOf(item).some((field) => field.required)
    return required || Boolean(draft.seen?.[item.id])
  }).length
}

export function toSubmission(items: ReadonlyArray<ItemInfo>, draft: Draft): ReviewResult.Submission {
  const result = items.flatMap((item) => {
    const saved = itemDraft(draft, item.id)
    const assets = item.assetIDs.flatMap((id) => {
      const asset = saved.assets?.[id]
      if (!asset) return []
      const annotations = asset.annotations?.filter(
        (annotation) => annotation.text?.trim() || annotation.shape !== "global",
      )
      if (!annotations?.length && asset.raw === undefined) return []
      return [
        {
          asset: id,
          ...(annotations?.length ? { annotations } : {}),
          ...(asset.raw !== undefined ? { raw: asset.raw } : {}),
          ...(asset.files?.length ? { files: asset.files } : {}),
        },
      ]
    })
    const answers = ReviewForm.sanitize(formOf(item), saved.answers, ReviewResult.MAX_TEXT)
    const custom = item.kind === "custom" ? saved.custom : undefined
    const verdict = item.kind === "custom" && (saved.verdict === "pass" || saved.verdict === "fail") ? saved.verdict : undefined
    const text = item.kind === "custom" ? saved.text?.trim() : undefined
    if (!answers && !verdict && !text && assets.length === 0 && custom === undefined) return []
    return [
      {
        id: item.id,
        ...(answers ? { answers } : {}),
        ...(verdict ? { verdict } : {}),
        ...(text ? { text } : {}),
        ...(assets.length > 0 ? { assets } : {}),
        ...(custom !== undefined ? { custom } : {}),
      },
    ]
  })
  const text = draft.text?.trim()
  return {
    decision: draft.decision,
    ...(text ? { text } : {}),
    ...(result.length > 0 ? { items: result } : {}),
  }
}

/** Suggests an overall decision from natural pass/fail answers; never overrides an explicit stop. */
export function suggest(items: ReadonlyArray<ItemInfo>, draft: Draft): Decision {
  if (draft.decision === "stop") return "stop"
  const judged = items.filter((item) => itemVerdict(item, draft) !== undefined)
  if (judged.some((item) => itemVerdict(item, draft) === "fail")) return "changes"
  if (judged.length > 0 && judged.every((item) => itemVerdict(item, draft) === "pass")) return "continue"
  return draft.decision
}
