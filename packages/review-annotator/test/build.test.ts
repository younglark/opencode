import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const html = fs.readFileSync(path.join(import.meta.dir, "..", "annotator.html"), "utf8")

describe("built annotator.html", () => {
  // Every inline <script> is a classic script sharing one global lexical scope, so a top-level
  // const/let/class declared twice throws a SyntaxError and that whole script never runs.
  test("declares no top-level lexical name twice across scripts", () => {
    const names = [...html.matchAll(/^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
    const seen = new Set<string>()
    const dupes = names.filter((name) => (seen.has(name) ? true : (seen.add(name), false)))
    expect(dupes).toEqual([])
  })

  test("keeps no ESM export statements", () => {
    expect(html).not.toMatch(/^export /m)
  })

  test("loads the video helpers", () => {
    expect(html).toContain("globalThis.ReviewAnnotatorVideo")
  })
})
