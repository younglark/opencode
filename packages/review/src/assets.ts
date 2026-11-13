export * as ReviewAssets from "./assets.js"

import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import type { ReviewRequest } from "./request.js"

/**
 * Review files live under one root (the server's data directory): `<root>/<bundle>/<item>/…` holds the snapshot of
 * an item's assets, `<root>/<reviewID>/feedback/` what the reviewer submitted. A snapshot is taken when the agent
 * asks, so later edits to the working tree do not change what is being reviewed.
 */
export const LIMITS = {
  image: 30 * 1024 * 1024,
  video: 300 * 1024 * 1024,
  other: 20 * 1024 * 1024,
  total: 1024 * 1024 * 1024,
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
}

export function mime(file: string) {
  return MIME[path.extname(file).toLowerCase()]
}

const kindOf = (type: string) => (type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : "other")

export class SnapshotError extends Error {}

/** A path inside a directory, or undefined when it would leave it. */
export function inside(base: string, relative: string) {
  if (relative === "" || relative.includes("\0")) return undefined
  const target = path.resolve(base, relative)
  const rel = path.relative(base, target)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined
  return target
}

async function hashFile(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

interface Budget {
  used: number
}

async function copy(input: {
  readonly source: string
  readonly target: string
  readonly file: string
  readonly allowed: ReadonlyArray<"image" | "video" | "other">
  readonly budget: Budget
}): Promise<ReviewRequest.StoredFile> {
  const type = mime(input.source)
  if (!type) throw new SnapshotError(`Unsupported file type: ${input.source}`)
  const kind = kindOf(type)
  if (!input.allowed.includes(kind)) throw new SnapshotError(`Expected ${input.allowed.join(" or ")}: ${input.source}`)
  const stat = await fs.stat(input.source).catch(() => undefined)
  if (!stat?.isFile()) throw new SnapshotError(`File not found: ${input.source}`)
  if (stat.size > LIMITS[kind])
    throw new SnapshotError(`${input.source} is ${stat.size} bytes; the ${kind} limit is ${LIMITS[kind]}`)
  input.budget.used += stat.size
  if (input.budget.used > LIMITS.total) throw new SnapshotError(`The review is larger than ${LIMITS.total} bytes`)
  await fs.mkdir(path.dirname(input.target), { recursive: true })
  await fs.copyFile(input.source, input.target)
  return { file: input.file, mime: type, size: stat.size, sha256: await hashFile(input.target), source: input.source }
}

const extension = (file: string) => path.extname(file).toLowerCase()

/** Copies every item's files into `<root>/<bundle>/<item>/`. Removes the bundle again when anything fails. */
export function snapshot(input: {
  readonly root: string
  readonly directory: string
  readonly bundle: string
  readonly items: ReadonlyArray<ReviewRequest.Item>
}): Effect.Effect<ReadonlyArray<ReviewRequest.StoredItem>, Error> {
  const bundleDir = path.join(input.root, input.bundle)
  return Effect.tryPromise({
    try: async () => {
      const budget: Budget = { used: 0 }
      const result: ReviewRequest.StoredItem[] = []
      for (const item of input.items) {
        const itemDir = path.join(bundleDir, item.id)
        const base = {
          id: item.id,
          kind: item.kind,
          title: item.title,
          ...(item.note ? { note: item.note } : {}),
          ...(item.feedback ? { feedback: item.feedback } : {}),
          bundle: input.bundle,
        }
        if (item.kind === "image" || item.kind === "video") {
          const allowed = [item.kind] as const
          const assets: ReviewRequest.StoredAsset[] = []
          for (const asset of item.assets ?? []) {
            const id = asset.id ?? asset.path
            const source = path.resolve(input.directory, asset.path)
            const file = id + extension(source)
            const stored = await copy({ source, target: path.join(itemDir, file), file, allowed, budget })
            const compareSource = asset.compare ? path.resolve(input.directory, asset.compare) : undefined
            const compareFile = compareSource ? `${id}.compare${extension(compareSource)}` : undefined
            const compare =
              compareSource && compareFile
                ? await copy({
                    source: compareSource,
                    target: path.join(itemDir, compareFile),
                    file: compareFile,
                    allowed: ["image"],
                    budget,
                  })
                : undefined
            assets.push({
              id,
              ...(asset.label ? { label: asset.label } : {}),
              ...(asset.fps ? { fps: asset.fps } : {}),
              stored,
              ...(compare ? { compare } : {}),
            })
          }
          result.push({ ...base, assets })
          continue
        }
        if (item.kind === "custom" && item.custom) {
          const entry = path.resolve(input.directory, item.custom.entry)
          const root = path.dirname(entry)
          const names = [path.basename(entry), ...(item.custom.files ?? [])]
          const files: ReviewRequest.StoredFile[] = []
          for (const name of [...new Set(names)]) {
            const source = inside(root, name)
            const relative = source ? path.relative(root, source).split(path.sep).join("/") : undefined
            const target = relative ? inside(itemDir, relative) : undefined
            if (!source || !relative || !target)
              throw new SnapshotError(`custom file must stay inside ${root}: ${name}`)
            files.push(await copy({ source, target, file: relative, allowed: ["image", "video", "other"], budget }))
          }
          result.push({ ...base, assets: [], custom: { entry: path.basename(entry), files } })
          continue
        }
        result.push({ ...base, assets: [], ...(item.diff ? { diff: item.diff } : {}) })
      }
      return result
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.tapError(() => Effect.promise(() => fs.rm(bundleDir, { recursive: true, force: true }).catch(() => {}))),
    Effect.mapError((error) =>
      error instanceof SnapshotError ? error : new Error(`Could not copy review files: ${error.message}`),
    ),
  )
}

/** The stored file an asset URL names: only files recorded in the item's snapshot are served. */
export function find(item: ReviewRequest.StoredItem, file: string): ReviewRequest.StoredFile | undefined {
  for (const asset of item.assets) {
    if (asset.stored.file === file) return asset.stored
    if (asset.compare?.file === file) return asset.compare
  }
  return item.custom?.files.find((stored) => stored.file === file)
}

export function filePath(root: string, item: ReviewRequest.StoredItem, stored: ReviewRequest.StoredFile) {
  return inside(path.join(root, item.bundle, item.id), stored.file)
}

/** Range responses are capped so a player asking for `bytes=0-` gets a chunk, not the whole file. */
export const MAX_RANGE = 8 * 1024 * 1024

export type Range =
  | { readonly type: "full" }
  | { readonly type: "partial"; readonly start: number; readonly end: number }
  | { readonly type: "unsatisfiable" }

/** One `bytes=` range of a file of `size` bytes; anything else is served whole. */
export function range(header: string | null | undefined, size: number): Range {
  if (!header) return { type: "full" }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === "" && match[2] === "")) return { type: "full" }
  let start: number
  let end: number
  if (match[1] === "") {
    const suffix = Number(match[2])
    if (suffix === 0) return { type: "unsatisfiable" }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (start >= size || end < start) return { type: "unsatisfiable" }
  return { type: "partial", start, end: Math.min(end, start + MAX_RANGE - 1) }
}

export async function readRange(file: string, start: number, end: number) {
  const handle = await fs.open(file, "r")
  try {
    const bytes = new Uint8Array(end - start + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, start + offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return bytes.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

/** Writes the submitted feedback: `feedback.json` and the uploaded images, into `<root>/<reviewID>/feedback/`. */
export async function writeFeedback(input: {
  readonly root: string
  readonly reviewID: string
  readonly json: unknown
  readonly files: ReadonlyMap<string, Uint8Array>
}) {
  const dir = path.join(input.root, input.reviewID, "feedback")
  await fs.mkdir(dir, { recursive: true })
  const paths = new Map<string, string>()
  for (const [name, bytes] of input.files) {
    const target = inside(dir, name)
    if (!target) continue
    await fs.writeFile(target, bytes)
    paths.set(name, target)
  }
  const feedback = path.join(dir, "feedback.json")
  await fs.writeFile(feedback, JSON.stringify(input.json, null, 2))
  return { dir, feedback, paths }
}
