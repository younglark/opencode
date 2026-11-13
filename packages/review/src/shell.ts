export * as ReviewShell from "./shell.js"

import type { ReviewRequest } from "./request.js"
import type { ReviewResult } from "./result.js"
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
  verdict?: Verdict
  text?: string
}

export interface ItemDraft {
  verdict?: Verdict
  text?: string
  checks?: { [id: string]: Verdict }
  assets?: { [id: string]: AssetDraft }
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

const asksVerdict = (item: ItemInfo) => Boolean(item.feedback?.verdict || item.feedback?.required)

/** An item-level verdict, or the one implied by its assets: any fail wins, else all must pass. */
export function itemVerdict(item: ItemInfo, draft: Draft): Verdict | undefined {
  const saved = itemDraft(draft, item.id)
  if (saved.verdict) return saved.verdict
  if (!item.feedback?.verdict || item.assetIDs.length === 0) return undefined
  const verdicts = item.assetIDs.map((id) => saved.assets?.[id]?.verdict)
  if (verdicts.some((verdict) => verdict === "fail")) return "fail"
  if (verdicts.every((verdict) => verdict === "pass")) return "pass"
  return undefined
}

function hasInput(item: ItemInfo, draft: Draft) {
  const saved = itemDraft(draft, item.id)
  if (saved.verdict || saved.text?.trim()) return true
  if (Object.values(saved.checks ?? {}).length > 0) return true
  return Object.values(saved.assets ?? {}).some((asset) => Boolean(asset.verdict || asset.text?.trim()))
}

export function status(item: ItemInfo, draft: Draft): Status {
  const verdict = itemVerdict(item, draft)
  if (verdict) return verdict
  if (draft.seen?.[item.id] || hasInput(item, draft)) return "open"
  return "unread"
}

/** Required items that still need a pass / fail (item-level, or every asset when verdicts are per asset). */
export function missing(items: ReadonlyArray<ItemInfo>, draft: Draft): ReadonlyArray<ItemInfo> {
  return items.filter((item) => item.feedback?.required && !itemVerdict(item, draft))
}

/** How many items count as done in the progress bar. */
export function completed(items: ReadonlyArray<ItemInfo>, draft: Draft) {
  return items.filter((item) =>
    asksVerdict(item) ? Boolean(itemVerdict(item, draft)) : Boolean(draft.seen?.[item.id]),
  ).length
}

export function toSubmission(items: ReadonlyArray<ItemInfo>, draft: Draft): ReviewResult.Submission {
  const result = items.flatMap((item) => {
    const saved = itemDraft(draft, item.id)
    const assets = item.assetIDs.flatMap((id) => {
      const asset = saved.assets?.[id]
      if (!asset) return []
      const text = asset.text?.trim()
      if (!asset.verdict && !text) return []
      return [{ asset: id, ...(asset.verdict ? { verdict: asset.verdict } : {}), ...(text ? { text } : {}) }]
    })
    const checks = (item.feedback?.checks ?? []).flatMap((check) => {
      const verdict = saved.checks?.[check.id]
      return verdict ? [{ id: check.id, verdict }] : []
    })
    const text = saved.text?.trim()
    if (!saved.verdict && !text && assets.length === 0 && checks.length === 0) return []
    return [
      {
        id: item.id,
        ...(saved.verdict ? { verdict: saved.verdict } : {}),
        ...(text ? { text } : {}),
        ...(assets.length > 0 ? { assets } : {}),
        ...(checks.length > 0 ? { checks } : {}),
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

/** Suggests an overall decision from item verdicts; never overrides an explicit stop. */
export function suggest(items: ReadonlyArray<ItemInfo>, draft: Draft): Decision {
  if (draft.decision === "stop") return "stop"
  if (items.some((item) => itemVerdict(item, draft) === "fail")) return "changes"
  if (
    items.some((item) => asksVerdict(item)) &&
    items.filter((item) => asksVerdict(item)).every((item) => itemVerdict(item, draft) === "pass")
  )
    return "continue"
  return draft.decision
}
