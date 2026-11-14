export * as ReviewRequest from "./request.js"

import { Schema } from "effect"
import { ReviewForm } from "./form.js"

/**
 * What an agent submits with `review_request`, and what idle / `now` reviews are built from. Three built-in kinds
 * hold one or more assets each (images, videos, the files of the session diff); `custom` is an agent-made
 * interactive page shown in a sandboxed iframe.
 */
export const Kind = Schema.Literals(["image", "video", "diff", "custom"])
export type Kind = typeof Kind.Type

export const Asset = Schema.Struct({
  path: Schema.String.annotate({ description: "File path, relative to the working directory or absolute" }),
  id: Schema.optionalKey(
    Schema.String.annotate({ description: "Stable id echoed back in the feedback; defaults to the file name" }),
  ),
  label: Schema.optionalKey(
    Schema.String.annotate({ description: "Short caption, e.g. 'far view' or 'Android 1080p'" }),
  ),
  compare: Schema.optionalKey(
    Schema.String.annotate({ description: "image only: a reference or previous image to compare against" }),
  ),
  fps: Schema.optionalKey(
    Schema.Finite.annotate({ description: "video only: frames per second, used for frame stepping" }),
  ),
})
export type Asset = typeof Asset.Type

export const Feedback = Schema.Struct({
  annotate: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Let the reviewer draw points/boxes (line comments for diff) per asset" }),
  ),
  form: Schema.optionalKey(
    Schema.Array(ReviewForm.Field).annotate({
      description:
        "Agent-defined feedback fields rendered in the item's pane: choice (one option), multi (many), or text. There is no built-in pass/fail, checklist, or comment; send those as form fields. A field with `when` is shown and required only when another field has a listed value.",
    }),
  ),
})
export type Feedback = typeof Feedback.Type

export const Item = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable id echoed back in the feedback, [A-Za-z0-9_.-], max 64" }),
  kind: Kind,
  title: Schema.String,
  note: Schema.optionalKey(Schema.String.annotate({ description: "What the reviewer should look at" })),
  feedback: Schema.optionalKey(Feedback),
  assets: Schema.optionalKey(
    Schema.Array(Asset).annotate({ description: "image / video: 1 to 20 files (videos: H.264 MP4 plays everywhere)" }),
  ),
  diff: Schema.optionalKey(
    Schema.Struct({
      files: Schema.optionalKey(
        Schema.Array(Schema.String).annotate({ description: "Only show these files of the session diff" }),
      ),
    }),
  ),
  custom: Schema.optionalKey(
    Schema.Struct({
      entry: Schema.String.annotate({ description: "HTML entry file of an agent-made review page" }),
      files: Schema.optionalKey(
        Schema.Array(Schema.String).annotate({ description: "Extra files the page loads, relative to the entry" }),
      ),
    }),
  ),
})
export type Item = typeof Item.Type

export const Wait = Schema.Struct({
  mode: Schema.Literals(["block", "async"]).annotate({
    description: "block: this call waits for the submission; async: it returns at once and feedback arrives later",
  }),
  timeoutMs: Schema.optionalKey(
    Schema.Finite.annotate({ description: "block only: stop waiting after this long (10 s to 24 h)" }),
  ),
  onTimeout: Schema.optionalKey(
    Schema.Struct({
      plan: Schema.String.annotate({ description: "What you will do if the time runs out, shown to the reviewer" }),
      link: Schema.Literals(["keep", "close"]).annotate({
        description: "keep: late feedback still arrives as a message; close: the link stops working",
      }),
    }),
  ),
})
export type Wait = typeof Wait.Type

export const Input = Schema.Struct({
  title: Schema.String,
  summary: Schema.optionalKey(Schema.String.annotate({ description: "Context the reviewer reads first" })),
  send: Schema.optionalKey(
    Schema.Literals(["now", "with_next_idle"]).annotate({
      description: "now (default): notify at once; with_next_idle: add the items to the next idle / now review",
    }),
  ),
  wait: Schema.optionalKey(Wait),
  items: Schema.Array(Item),
})
export type Input = typeof Input.Type

/** A snapshotted file: copied into the review's storage when the request was made. */
export const StoredFile = Schema.Struct({
  /** Path under the item's storage directory, as served below `/a/<token>/<item>/`. */
  file: Schema.String,
  mime: Schema.String,
  size: Schema.Finite,
  sha256: Schema.String,
  /** Where it was copied from, for the agent's reference only. */
  source: Schema.String,
})
export type StoredFile = typeof StoredFile.Type

export const StoredAsset = Schema.Struct({
  id: Schema.String,
  label: Schema.optionalKey(Schema.String),
  fps: Schema.optionalKey(Schema.Finite),
  stored: StoredFile,
  compare: Schema.optionalKey(StoredFile),
})
export type StoredAsset = typeof StoredAsset.Type

export const StoredItem = Schema.Struct({
  id: Schema.String,
  kind: Kind,
  title: Schema.String,
  note: Schema.optionalKey(Schema.String),
  feedback: Schema.optionalKey(Feedback),
  /** Storage directory name under the review root that holds this item's files. */
  bundle: Schema.String,
  assets: Schema.Array(StoredAsset),
  diff: Schema.optionalKey(Schema.Struct({ files: Schema.optionalKey(Schema.Array(Schema.String)) })),
  custom: Schema.optionalKey(Schema.Struct({ entry: Schema.String, files: Schema.Array(StoredFile) })),
})
export type StoredItem = typeof StoredItem.Type

export const Stored = Schema.Struct({
  items: Schema.Array(StoredItem),
  wait: Schema.optionalKey(Wait),
})
export type Stored = typeof Stored.Type

export const MAX_ITEMS = 50
export const MAX_ASSETS = 20
export const MAX_CUSTOM_FILES = 200
export const MIN_TIMEOUT = 10_000
export const MAX_TIMEOUT = 24 * 60 * 60_000
const ID = /^[A-Za-z0-9_.-]{1,64}$/

/** A file name made safe as an id: the base name without extension, reduced to the id alphabet. */
export function idFrom(path: string) {
  const base = path.split(/[\\/]/).pop() ?? path
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base
  const clean = stem.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 64)
  return clean === "" || clean === "." || clean === ".." ? "asset" : clean
}

/** Fills asset ids and reports every problem at once, so the agent can fix the call in one go. */
export function validate(
  input: Input,
): { readonly ok: true; readonly input: Input } | { readonly ok: false; readonly errors: string[] } {
  const errors: string[] = []
  if (input.title.trim() === "") errors.push("title is empty")
  if (input.items.length === 0) errors.push("items is empty")
  if (input.items.length > MAX_ITEMS) errors.push(`at most ${MAX_ITEMS} items`)
  const wait = input.wait
  if (wait?.timeoutMs !== undefined) {
    if (wait.mode !== "block") errors.push("wait.timeoutMs only applies to mode block")
    if (!(wait.timeoutMs >= MIN_TIMEOUT && wait.timeoutMs <= MAX_TIMEOUT))
      errors.push(`wait.timeoutMs must be between ${MIN_TIMEOUT} and ${MAX_TIMEOUT}`)
  }
  if (input.send === "with_next_idle" && wait?.mode === "block") errors.push("send with_next_idle cannot block")
  const itemIDs = new Set<string>()
  const items = input.items.map((item, index) => {
    const at = `items[${index}]`
    if (!ID.test(item.id)) errors.push(`${at}.id must match [A-Za-z0-9_.-]{1,64}`)
    else if (itemIDs.has(item.id)) errors.push(`${at}.id "${item.id}" is used twice`)
    itemIDs.add(item.id)
    if (item.title.trim() === "") errors.push(`${at}.title is empty`)
    const assets = item.assets ?? []
    if (item.kind === "image" || item.kind === "video") {
      if (assets.length === 0) errors.push(`${at}: ${item.kind} needs at least one asset`)
      if (assets.length > MAX_ASSETS) errors.push(`${at}: at most ${MAX_ASSETS} assets`)
    } else if (assets.length > 0) errors.push(`${at}: ${item.kind} takes no assets`)
    if (item.kind === "custom" && !item.custom) errors.push(`${at}: custom needs custom.entry`)
    if (item.kind !== "custom" && item.custom) errors.push(`${at}: only custom takes custom`)
    if (item.kind !== "diff" && item.diff) errors.push(`${at}: only diff takes diff`)
    if ((item.custom?.files?.length ?? 0) > MAX_CUSTOM_FILES)
      errors.push(`${at}: at most ${MAX_CUSTOM_FILES} custom files`)
    errors.push(...ReviewForm.validate(item.feedback?.form, at))
    const assetIDs = new Set<string>()
    const filled = assets.map((asset, assetIndex) => {
      const id = asset.id ?? idFrom(asset.path)
      const where = `${at}.assets[${assetIndex}]`
      if (!ID.test(id)) errors.push(`${where}.id must match [A-Za-z0-9_.-]{1,64}`)
      else if (assetIDs.has(id)) errors.push(`${where}.id "${id}" is used twice; set distinct ids`)
      assetIDs.add(id)
      if (asset.compare !== undefined && item.kind !== "image") errors.push(`${where}.compare is for images only`)
      if (asset.fps !== undefined && (item.kind !== "video" || !(asset.fps > 0 && asset.fps <= 240)))
        errors.push(`${where}.fps must be a video frame rate between 0 and 240`)
      return { ...asset, id }
    })
    return item.kind === "image" || item.kind === "video" ? { ...item, assets: filled } : item
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, input: { ...input, items } }
}

/** The item idle / `now` reviews carry: the whole session diff, judged per file. */
export function diffItem(bundle: string): StoredItem {
  return {
    id: "diff",
    kind: "diff",
    title: "代码改动",
    bundle,
    assets: [],
    feedback: { annotate: true, form: [ReviewForm.verdictChoice()] },
  }
}

/** How the reviewer is told what the agent does meanwhile. */
export function describeWait(wait: Wait | undefined, createdAt: number) {
  if (!wait || wait.mode === "async") return "Agent 没有停下来等你，会继续做别的；提交后反馈会发给它。"
  if (wait.timeoutMs === undefined) return "Agent 正在等你的反馈，提交后它才继续。"
  const until = new Date(createdAt + wait.timeoutMs).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  })
  const plan = wait.onTimeout?.plan.trim()
  const link = wait.onTimeout?.link === "close" ? "到时链接会失效。" : "到时之后提交，反馈仍会发给它。"
  return `Agent 最多等到 ${until}。${plan ? `之后：${plan}。` : ""}${link}`
}

export const decodeStored = Schema.decodeUnknownOption(Stored)
