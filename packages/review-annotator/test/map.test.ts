import { describe, expect, test } from "bun:test"
import { dataUrlBytes, fileName, frameFileName, fromFeedback, fromVideoFeedback, snapshotIfSmall, stripImage } from "../host/map.js"

const feedback = {
  schemaVersion: "feedback-minimal-4",
  objects: [
    { kind: "point", point: { x: 12, y: 40 }, annotations: [{ number: 1, text: "这里有白点" }] },
    { kind: "region", source: { x1: 10, y1: 20, x2: 80, y2: 90 }, annotations: [{ number: 2, text: "阴影反了" }] },
    { kind: "global", source: null, annotations: [{ number: 3, text: "整体偏暗" }] },
    {
      kind: "region",
      source: { x1: 1, y1: 1, x2: 2, y2: 2 },
      annotations: [{ number: 4, text: "父级" }],
      children: [{ kind: "point", point: { x: 3, y: 4 }, annotations: [{ number: 5, text: "子标注" }] }],
    },
  ],
}

describe("fromFeedback", () => {
  test("maps point, rect and global objects, including children", () => {
    expect(fromFeedback(feedback)).toEqual([
      { n: 1, shape: "point", rect: { x1: 12, y1: 40, x2: 12, y2: 40 }, text: "这里有白点" },
      { n: 2, shape: "rect", rect: { x1: 10, y1: 20, x2: 80, y2: 90 }, text: "阴影反了" },
      { n: 3, shape: "global", text: "整体偏暗" },
      { n: 4, shape: "rect", rect: { x1: 1, y1: 1, x2: 2, y2: 2 }, text: "父级" },
      { n: 5, shape: "point", rect: { x1: 3, y1: 4, x2: 3, y2: 4 }, text: "子标注" },
    ])
  })

  test("drops empty global notes and accepts a missing list", () => {
    expect(fromFeedback({ objects: [{ kind: "global", annotations: [{ number: 1, text: "  " }] }] })).toEqual([])
    expect(fromFeedback(undefined)).toEqual([])
  })
})

describe("stripImage and file names", () => {
  test("removes embedded data URLs from a feedback draft", () => {
    const stripped = stripImage({
      image: { mode: "embedded", dataUrl: "data:image/png;base64,aaaa", width: 1 },
      objects: feedback.objects,
    })
    expect(stripped.image.dataUrl).toBeUndefined()
    expect(stripped.image.mode).toBe("none")
    expect(stripped.objects[0].annotations[0].text).toBe("这里有白点")
  })

  test("builds a filename the submit route will accept", () => {
    expect(fileName("shots", "far")).toBe("shots-far.annotated.png")
    expect(fileName("boss room!", "../x")).toBe("boss_room-x.annotated.png")
  })

  test("refuses a snapshot that would blow the submit cap", () => {
    const tiny = "data:image/png;base64,aaaa"
    expect(snapshotIfSmall(tiny)).toBe(tiny)
    expect(dataUrlBytes(tiny)).toBeGreaterThan(0)
    const huge = "data:image/png;base64," + "A".repeat(12 * 1024 * 1024)
    expect(snapshotIfSmall(huge)).toBeUndefined()
  })
})

describe("video feedback", () => {
  test("attaches timestamp, microseconds and frame index to each mark", () => {
    const feedback = {
      schemaVersion: "video-feedback-1",
      frames: [
        {
          id: "t-3200000",
          timestampUs: 3_200_000,
          timestampMs: 3200,
          feedback: {
            objects: [{ kind: "region", source: { x1: 10, y1: 20, x2: 80, y2: 90 }, annotations: [{ number: 1, text: "拖尾断开" }] }],
          },
        },
      ],
    }
    expect(fromVideoFeedback(feedback, 30)).toEqual([
      {
        n: 1,
        shape: "rect",
        rect: { x1: 10, y1: 20, x2: 80, y2: 90 },
        text: "拖尾断开",
        frame: { timeMs: 3200, timeUs: 3_200_000, index: 96 },
      },
    ])
  })

  test("builds a per-frame snapshot name the submit route will accept", () => {
    expect(frameFileName("clip", "c", { index: 96, timeMs: 3200 })).toBe("clip-c-f96.annotated.png")
    expect(frameFileName("clip", "c", { timeMs: 3200 })).toBe("clip-c-t3200.annotated.png")
  })
})
