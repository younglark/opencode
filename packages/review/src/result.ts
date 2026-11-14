export * as ReviewResult from "./result.js"

import { Option, Schema } from "effect"
import type { ReviewRequest } from "./request.js"
import { ReviewCustom } from "./custom.js"
import { ReviewState } from "./state.js"

/** What the approval page submits once, for every item at the same time. */
const Verdict = Schema.Literals(["pass", "fail"])
export type Verdict = typeof Verdict.Type

const Rect = Schema.Struct({ x1: Schema.Finite, y1: Schema.Finite, x2: Schema.Finite, y2: Schema.Finite })

export const Annotation = Schema.Struct({
  n: Schema.Finite,
  shape: Schema.Literals(["point", "rect", "global", "line"]),
  /** Pixels of the original image or frame, origin top left, right / bottom edges exclusive. */
  rect: Schema.optionalKey(Rect),
  /** Video: the media time of the captured frame, its index when the frame rate is known, and its image file. */
  frame: Schema.optionalKey(
    Schema.Struct({
      timeMs: Schema.Finite,
      timeUs: Schema.optionalKey(Schema.Finite),
      index: Schema.optionalKey(Schema.Finite),
      image: Schema.optionalKey(Schema.String),
    }),
  ),
  /** Diff: lines of the asset's file. */
  line: Schema.optionalKey(
    Schema.Struct({
      side: Schema.Literals(["old", "new"]),
      start: Schema.Finite,
      end: Schema.optionalKey(Schema.Finite),
    }),
  ),
  text: Schema.String,
})
export type Annotation = typeof Annotation.Type

export const AssetResult = Schema.Struct({
  asset: Schema.String,
  verdict: Schema.optionalKey(Verdict),
  text: Schema.optionalKey(Schema.String),
  annotations: Schema.optionalKey(Schema.Array(Annotation)),
  /** Uploaded images (numbered annotation renders, frames), by their name in the submission. */
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  raw: Schema.optionalKey(Schema.Unknown),
})
export type AssetResult = typeof AssetResult.Type

export const ItemResult = Schema.Struct({
  id: Schema.String,
  verdict: Schema.optionalKey(Verdict),
  checks: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String, verdict: Verdict }))),
  text: Schema.optionalKey(Schema.String),
  assets: Schema.optionalKey(Schema.Array(AssetResult)),
  custom: Schema.optionalKey(Schema.Unknown),
})
export type ItemResult = typeof ItemResult.Type

export const Submission = Schema.Struct({
  decision: ReviewState.Decision,
  text: Schema.optionalKey(Schema.String),
  items: Schema.optionalKey(Schema.Array(ItemResult)),
})
export type Submission = typeof Submission.Type

/** The checked submission, as stored in `feedback.json` and rendered for the agent. */
export interface Result {
  readonly reviewID: string
  readonly submittedAt: string
  readonly decision: ReviewState.Decision
  readonly text?: string
  readonly items: ReadonlyArray<CheckedItem>
  readonly skipped: ReadonlyArray<string>
}

export interface CheckedItem {
  readonly id: string
  readonly kind: ReviewRequest.Kind
  readonly title: string
  readonly verdict?: Verdict
  readonly checks?: ReadonlyArray<{ readonly id: string; readonly label: string; readonly verdict: Verdict }>
  readonly text?: string
  readonly assets: ReadonlyArray<CheckedAsset>
  readonly custom?: unknown
}

export interface CheckedAsset {
  readonly asset: string
  readonly label?: string
  readonly verdict?: Verdict
  readonly text?: string
  readonly annotations: ReadonlyArray<Annotation>
  readonly files: ReadonlyArray<string>
  readonly raw?: unknown
}

export const MAX_TEXT = 8_000
export const MAX_ANNOTATIONS = 200
export const MAX_FILES = 60
export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS = 12
export const MAX_ATTACHMENTS_PER_ITEM = 4
const FILE_NAME = /^[A-Za-z0-9_.-]{1,128}\.(png|jpe?g|webp)$/

const decodeSubmission = Schema.decodeUnknownOption(Submission)
const clip = (text: string | undefined) => {
  const trimmed = text?.trim().slice(0, MAX_TEXT)
  return trimmed ? trimmed : undefined
}

export function fileName(name: string) {
  return FILE_NAME.test(name) && !name.startsWith(".")
}

/**
 * Checks a submission against the request: unknown items, assets and checks are dropped, texts clipped, and file
 * references kept only when the file was uploaded. Items with nothing in them are listed as skipped.
 */
export function check(input: {
  readonly reviewID: string
  readonly now: number
  readonly raw: unknown
  readonly items: ReadonlyArray<ReviewRequest.StoredItem>
  /** Names of the uploaded files; diff items list their files from the session diff. */
  readonly uploaded: ReadonlySet<string>
  readonly diffFiles?: ReadonlyArray<string>
}): Result | undefined {
  const submission = Option.getOrUndefined(decodeSubmission(input.raw))
  if (!submission) return undefined
  const byID = new Map((submission.items ?? []).map((item) => [item.id, item]))
  const items: CheckedItem[] = []
  const skipped: string[] = []
  let annotationBudget = MAX_ANNOTATIONS
  for (const item of input.items) {
    const sent = byID.get(item.id)
    const known =
      item.kind === "diff"
        ? new Map((input.diffFiles ?? []).map((file) => [file, undefined as string | undefined]))
        : new Map(item.assets.map((asset) => [asset.id, asset.label]))
    const assets: CheckedAsset[] = []
    for (const asset of sent?.assets ?? []) {
      // Diff files outside the current diff still count: the diff may have changed since the page loaded.
      if (item.kind !== "diff" && !known.has(asset.asset)) continue
      if (item.kind === "diff" && asset.asset.length > 1024) continue
      const annotations = (asset.annotations ?? [])
        .slice(0, Math.max(0, annotationBudget))
        .map((annotation) => ({ ...annotation, text: annotation.text.trim().slice(0, MAX_TEXT) }))
        .filter((annotation) => annotation.text !== "" || annotation.shape !== "global")
      annotationBudget -= annotations.length
      const files = (asset.files ?? []).filter((name) => input.uploaded.has(name))
      const text = clip(asset.text)
      if (!asset.verdict && !text && annotations.length === 0 && files.length === 0) continue
      const label = known.get(asset.asset)
      assets.push({
        asset: asset.asset,
        ...(label ? { label } : {}),
        ...(asset.verdict ? { verdict: asset.verdict } : {}),
        ...(text ? { text } : {}),
        annotations,
        files,
        ...(asset.raw !== undefined ? { raw: asset.raw } : {}),
      })
    }
    const labels = new Map((item.feedback?.checks ?? []).map((check) => [check.id, check.label]))
    const checks = (sent?.checks ?? []).flatMap((check) => {
      const label = labels.get(check.id)
      return label === undefined ? [] : [{ id: check.id, label, verdict: check.verdict }]
    })
    const verdicts = assets.flatMap((asset) => (asset.verdict ? [asset.verdict] : []))
    const verdict =
      sent?.verdict ?? (verdicts.includes("fail") ? "fail" : verdicts.length > 0 ? ("pass" as const) : undefined)
    const text = clip(sent?.text)
    const custom = item.kind === "custom" ? ReviewCustom.clip(sent?.custom) : undefined
    if (!verdict && !text && assets.length === 0 && checks.length === 0 && custom === undefined) {
      skipped.push(item.id)
      continue
    }
    items.push({
      id: item.id,
      kind: item.kind,
      title: item.title,
      ...(verdict ? { verdict } : {}),
      ...(checks.length > 0 ? { checks } : {}),
      ...(text ? { text } : {}),
      assets,
      ...(custom !== undefined ? { custom } : {}),
    })
  }
  const text = clip(submission.text)
  return {
    reviewID: input.reviewID,
    submittedAt: new Date(input.now).toISOString(),
    decision: submission.decision,
    ...(text ? { text } : {}),
    items,
    skipped,
  }
}

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"
const mark = (n: number) => (n >= 1 && n <= 20 ? CIRCLED[n - 1] : `(${n})`)
const verdictText = (verdict: Verdict | undefined) =>
  verdict === "pass" ? " ✓ pass" : verdict === "fail" ? " ✗ fail" : ""

function clock(ms: number) {
  const total = Math.max(0, Math.round(ms))
  const minutes = Math.floor(total / 60_000)
  const seconds = ((total % 60_000) / 1000).toFixed(3).padStart(6, "0")
  return `${String(minutes).padStart(2, "0")}:${seconds}`
}

function where(annotation: Annotation) {
  const parts: string[] = []
  if (annotation.frame)
    parts.push(
      `@${clock(annotation.frame.timeMs)}${annotation.frame.index !== undefined ? ` (frame ${annotation.frame.index})` : ""}`,
    )
  if (annotation.line)
    parts.push(
      `${annotation.line.side} line ${annotation.line.start}${annotation.line.end && annotation.line.end !== annotation.line.start ? `-${annotation.line.end}` : ""}`,
    )
  const r = annotation.rect
  if (annotation.shape === "point" && r) parts.push(`point (${Math.round(r.x1)},${Math.round(r.y1)})`)
  if (annotation.shape === "rect" && r)
    parts.push(`box (${Math.round(r.x1)},${Math.round(r.y1)})-(${Math.round(r.x2)},${Math.round(r.y2)})`)
  if (annotation.shape === "global") parts.push("whole")
  return parts.join(" ")
}

/** The message the agent reads: one block per item, coordinates and frame times inline, file names for images. */
export function prompt(result: Result, feedbackPath?: string) {
  const head =
    result.decision === "continue"
      ? "[Remote review] I reviewed your work. Looks good, please continue."
      : result.decision === "stop"
        ? "[Remote review] I reviewed your work. Please stop here; do not continue."
        : "[Remote review] I reviewed your work and request these changes:"
  const lines = [head]
  if (result.text) lines.push("", result.text)
  result.items.forEach((item, index) => {
    lines.push("", `${index + 1}. ${item.kind} "${item.title}" [${item.id}]${verdictText(item.verdict)}`)
    if (item.text) lines.push(`   ${item.text.replaceAll("\n", "\n   ")}`)
    for (const check of item.checks ?? []) lines.push(`   check "${check.label}"${verdictText(check.verdict)}`)
    for (const asset of item.assets) {
      const name = asset.label ? `${asset.asset} (${asset.label})` : asset.asset
      lines.push(`   - ${name}${verdictText(asset.verdict)}`)
      if (asset.text) lines.push(`     ${asset.text.replaceAll("\n", "\n     ")}`)
      for (const annotation of asset.annotations)
        lines.push(`     ${mark(annotation.n)} ${where(annotation)}: ${annotation.text.replaceAll("\n", " ")}`)
      if (asset.files.length > 0) lines.push(`     images: ${asset.files.join(", ")}`)
    }
    if (item.custom !== undefined) {
      const json = JSON.stringify(item.custom)
      lines.push(`   page result: ${json.length > 2_000 ? json.slice(0, 2_000) + "…" : json}`)
    }
  })
  if (result.skipped.length > 0) lines.push("", `Not reviewed: ${result.skipped.join(", ")}`)
  if (feedbackPath) lines.push("", `Full feedback JSON: ${feedbackPath}`)
  return lines.join("\n")
}

/** Which uploaded images go along as attachments: per item first, in order, within the caps. */
export function attachments(result: Result) {
  const picked: string[] = []
  for (const item of result.items) {
    let count = 0
    for (const asset of item.assets)
      for (const file of asset.files) {
        if (picked.length >= MAX_ATTACHMENTS || count >= MAX_ATTACHMENTS_PER_ITEM) break
        if (picked.includes(file)) continue
        picked.push(file)
        count++
      }
  }
  return picked
}

export function metadata(reviewID: string, decision: ReviewState.Decision) {
  return { source: ReviewState.FEEDBACK_SOURCE, reviewID, decision }
}
