import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ReviewAssets } from "../src/assets.js"
import { run } from "./fixture.js"

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "review-assets-"))
const work = path.join(temp, "work")
const root = path.join(temp, "root")
afterAll(() => fs.rm(temp, { recursive: true, force: true }))

await fs.mkdir(path.join(work, "out"), { recursive: true })
await fs.mkdir(path.join(work, "page", "css"), { recursive: true })
await fs.writeFile(path.join(work, "out", "far.png"), "PNG1")
await fs.writeFile(path.join(work, "out", "ref.jpg"), "JPG")
await fs.writeFile(path.join(work, "out", "clip.mp4"), Buffer.alloc(100, 7))
await fs.writeFile(path.join(work, "page", "index.html"), "<h1>hi</h1>")
await fs.writeFile(path.join(work, "page", "css", "a.css"), "h1{}")
await fs.writeFile(path.join(work, "notes.txt"), "secret")

describe("snapshot", () => {
  test("copies assets per item, records hashes and serves only recorded files", async () => {
    const items = await run(
      ReviewAssets.snapshot({
        root,
        directory: work,
        bundle: "r1",
        items: [
          {
            id: "shots",
            kind: "image",
            title: "Shots",
            assets: [{ id: "far", path: "out/far.png", compare: "out/ref.jpg", label: "远景" }],
          },
          { id: "clip", kind: "video", title: "Clip", assets: [{ id: "c1", path: "out/clip.mp4", fps: 30 }] },
          { id: "page", kind: "custom", title: "Page", custom: { entry: "page/index.html", files: ["css/a.css"] } },
          { id: "diff", kind: "diff", title: "Diff", diff: { files: ["a.ts"] } },
        ],
      }),
    )
    expect(items[0].assets[0]).toMatchObject({
      id: "far",
      label: "远景",
      stored: { file: "far.png", mime: "image/png", size: 4 },
      compare: { file: "far.compare.jpg", mime: "image/jpeg" },
    })
    expect(items[0].assets[0].stored.sha256).toHaveLength(64)
    expect(items[1].assets[0]).toMatchObject({ fps: 30, stored: { file: "c1.mp4", mime: "video/mp4", size: 100 } })
    expect(items[2].custom?.files.map((file) => file.file)).toEqual(["index.html", "css/a.css"])
    expect(items[3]).toMatchObject({ kind: "diff", diff: { files: ["a.ts"] }, assets: [] })
    // Later edits to the working tree do not change the snapshot.
    await fs.writeFile(path.join(work, "out", "far.png"), "PNG2")
    const stored = ReviewAssets.find(items[0], "far.png")!
    expect(await fs.readFile(ReviewAssets.filePath(root, items[0], stored)!, "utf8")).toBe("PNG1")
    expect(ReviewAssets.find(items[0], "../clip/c1.mp4")).toBeUndefined()
    expect(ReviewAssets.find(items[2], "css/a.css")?.mime).toContain("text/css")
  })

  test("rejects missing files, wrong kinds, escapes and unknown types, and leaves no bundle behind", async () => {
    const attempt = (items: Parameters<typeof ReviewAssets.snapshot>[0]["items"]) =>
      Effect.runPromise(Effect.flip(ReviewAssets.snapshot({ root, directory: work, bundle: "bad", items })))
    expect(
      (await attempt([{ id: "a", kind: "image", title: "A", assets: [{ id: "x", path: "out/none.png" }] }])).message,
    ).toContain("File not found")
    expect(
      (await attempt([{ id: "a", kind: "image", title: "A", assets: [{ id: "x", path: "out/clip.mp4" }] }])).message,
    ).toContain("Expected image")
    expect(
      (
        await attempt([
          { id: "p", kind: "custom", title: "P", custom: { entry: "page/index.html", files: ["../notes.txt"] } },
        ])
      ).message,
    ).toContain("must stay inside")
    expect(
      (await attempt([{ id: "a", kind: "video", title: "A", assets: [{ id: "x", path: "notes.txt" }] }])).message,
    ).toContain("Expected video")
    expect(await fs.stat(path.join(root, "bad")).catch(() => undefined)).toBeUndefined()
  })
})

describe("ranges", () => {
  test("parses one bytes range, caps open ends and rejects what cannot be served", () => {
    expect(ReviewAssets.range(null, 100)).toEqual({ type: "full" })
    expect(ReviewAssets.range("bytes=0-9", 100)).toEqual({ type: "partial", start: 0, end: 9 })
    expect(ReviewAssets.range("bytes=90-", 100)).toEqual({ type: "partial", start: 90, end: 99 })
    expect(ReviewAssets.range("bytes=-10", 100)).toEqual({ type: "partial", start: 90, end: 99 })
    expect(ReviewAssets.range("bytes=0-", 100 * 1024 * 1024)).toEqual({
      type: "partial",
      start: 0,
      end: ReviewAssets.MAX_RANGE - 1,
    })
    expect(ReviewAssets.range("bytes=100-", 100)).toEqual({ type: "unsatisfiable" })
    expect(ReviewAssets.range("bytes=0-1,4-5", 100)).toEqual({ type: "full" })
  })

  test("reads the requested bytes", async () => {
    const file = path.join(work, "range.bin")
    await fs.writeFile(file, Buffer.from("0123456789"))
    expect(Buffer.from(await ReviewAssets.readRange(file, 2, 5)).toString()).toBe("2345")
  })
})

describe("feedback files", () => {
  test("writes feedback.json and the uploaded images, skipping names that escape", async () => {
    const written = await ReviewAssets.writeFeedback({
      root,
      reviewID: "r9",
      json: { ok: true },
      files: new Map([
        ["a.png", new Uint8Array([1, 2])],
        ["../b.png", new Uint8Array([3])],
      ]),
    })
    expect(JSON.parse(await fs.readFile(written.feedback, "utf8"))).toEqual({ ok: true })
    expect([...written.paths.keys()]).toEqual(["a.png"])
    expect(written.dir).toBe(path.join(root, "r9", "feedback"))
  })
})
