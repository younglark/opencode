// Host adapter (not upstream EditHere code). Maps feedback-minimal-4 and video-feedback-1 objects
// to the review Annotation[] shape and strips embedded images from drafts.
(function (root, factory) {
  const api = factory()
  if (typeof module === "object" && module.exports) module.exports = api
  root.ReviewAnnotatorMap = api
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const flatten = (objects, into = []) => {
    for (const object of objects || []) {
      if (!object || typeof object !== "object") continue
      into.push(object)
      if (Array.isArray(object.children)) flatten(object.children, into)
    }
    return into
  }

  const pointRect = (object) => {
    if (object.point && Number.isFinite(object.point.x) && Number.isFinite(object.point.y))
      return { x1: object.point.x, y1: object.point.y, x2: object.point.x, y2: object.point.y }
    const source = object.source
    if (source && Number.isFinite(source.x1) && Number.isFinite(source.y1))
      return { x1: source.x1, y1: source.y1, x2: source.x2 ?? source.x1, y2: source.y2 ?? source.y1 }
    return undefined
  }

  const regionRect = (object) => {
    const source = object.source
    if (!source || !Number.isFinite(source.x1) || !Number.isFinite(source.y1)) return undefined
    return { x1: source.x1, y1: source.y1, x2: source.x2, y2: source.y2 }
  }

  const kindOf = (object) => {
    if (object.kind === "point" || object.kind === "global" || object.kind === "region") return object.kind
    if (object.source == null && !object.point) return "global"
    if (object.point || (object.source && object.source.x1 === object.source.x2 && object.source.y1 === object.source.y2))
      return "point"
    return "region"
  }

  /** @returns {Array<{n:number, shape:'point'|'rect'|'global', rect?:object, text:string}>} */
  function fromFeedback(feedback) {
    const out = []
    for (const object of flatten(feedback?.objects)) {
      const kind = kindOf(object)
      const shape = kind === "point" ? "point" : kind === "global" ? "global" : "rect"
      const rect = shape === "global" ? undefined : shape === "point" ? pointRect(object) : regionRect(object)
      const annotations = Array.isArray(object.annotations) ? object.annotations : []
      for (const annotation of annotations) {
        const text = (typeof annotation === "string" ? annotation : annotation?.text || "").trim()
        if (!text && shape === "global") continue
        const n =
          typeof annotation === "object" && Number.isFinite(annotation.number) ? annotation.number : out.length + 1
        const entry = { n, shape, text: text || "" }
        if (rect) entry.rect = rect
        out.push(entry)
      }
    }
    out.sort((a, b) => a.n - b.n)
    return out
  }

  function stripImage(value) {
    if (!value || typeof value !== "object") return value
    const copy = structuredClone(value)
    const walk = (node) => {
      if (!node || typeof node !== "object") return
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      if (node.image && typeof node.image === "object") {
        const image = { ...node.image }
        delete image.dataUrl
        if (image.mode === "embedded") image.mode = "none"
        node.image = image
      }
      if (typeof node.dataUrl === "string" && node.dataUrl.startsWith("data:")) delete node.dataUrl
      for (const key of Object.keys(node)) walk(node[key])
    }
    walk(copy)
    return copy
  }

  const partName = (value) =>
    String(value || "asset")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_")
      .slice(0, 40) || "asset"

  function fileName(item, asset) {
    const name = `${partName(item)}-${partName(asset)}.annotated.png`
    return name.length <= 128 ? name : "annotated.png"
  }

  function frameFileName(item, asset, frame = {}) {
    const tag =
      Number.isFinite(frame.index) ? "f" + Math.round(frame.index) : "t" + Math.round(frame.timeMs || 0)
    const name = `${partName(item)}-${partName(asset)}-${tag}.annotated.png`
    return name.length <= 128 ? name : "frame.annotated.png"
  }

  function frameIndex(timeSec, fps) {
    if (!(fps > 0) || !Number.isFinite(timeSec)) return undefined
    return Math.max(0, Math.round(timeSec * fps - 0.5))
  }

  function fromVideoFeedback(feedback, fps) {
    const frames = feedback?.frames
    if (!Array.isArray(frames)) return fromFeedback(feedback)
    const out = []
    for (const frame of frames) {
      const timeUs = Number.isFinite(frame.timestampUs) ? frame.timestampUs : undefined
      const timeMs = Number.isFinite(frame.timestampMs)
        ? frame.timestampMs
        : timeUs !== undefined
          ? Math.floor(timeUs / 1000)
          : undefined
      const timeSec = timeUs !== undefined ? timeUs / 1_000_000 : timeMs !== undefined ? timeMs / 1000 : undefined
      const index = frameIndex(timeSec, fps ?? feedback.fps)
      const marks = fromFeedback(frame.feedback)
      for (const mark of marks) {
        const meta = {}
        if (timeMs !== undefined) meta.timeMs = timeMs
        if (timeUs !== undefined) meta.timeUs = timeUs
        if (index !== undefined) meta.index = index
        if (Object.keys(meta).length) mark.frame = meta
        out.push(mark)
      }
    }
    return out
  }

  function annotationsOf(feedback, fps) {
    if (feedback && (feedback.schemaVersion === "video-feedback-1" || Array.isArray(feedback.frames)))
      return fromVideoFeedback(feedback, fps ?? feedback.fps)
    return fromFeedback(feedback)
  }

  function frameNotes(raw) {
    if (Array.isArray(raw?.frameNotes)) return raw.frameNotes
    if (!Array.isArray(raw?.frames)) return []
    return raw.frames.map((frame) => ({
      id: frame.id,
      timestampUs: frame.timestampUs,
      notes: frame.notes,
      layout: frame.layout,
    }))
  }

  const MAX_SNAPSHOT = 8 * 1024 * 1024

  function dataUrlBytes(dataUrl) {
    const comma = dataUrl.indexOf(",")
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
    return Math.floor((b64.length * 3) / 4)
  }

  function snapshotIfSmall(dataUrl) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return undefined
    if (dataUrlBytes(dataUrl) > MAX_SNAPSHOT) return undefined
    return dataUrl
  }

  return { fromFeedback, fromVideoFeedback, annotationsOf, stripImage, fileName, frameFileName, frameNotes, frameIndex, flatten, dataUrlBytes, snapshotIfSmall, MAX_SNAPSHOT }
})

export const fromFeedback = globalThis.ReviewAnnotatorMap.fromFeedback
export const fromVideoFeedback = globalThis.ReviewAnnotatorMap.fromVideoFeedback
export const annotationsOf = globalThis.ReviewAnnotatorMap.annotationsOf
export const stripImage = globalThis.ReviewAnnotatorMap.stripImage
export const fileName = globalThis.ReviewAnnotatorMap.fileName
export const frameFileName = globalThis.ReviewAnnotatorMap.frameFileName
export const frameNotes = globalThis.ReviewAnnotatorMap.frameNotes
export const frameIndex = globalThis.ReviewAnnotatorMap.frameIndex
export const flatten = globalThis.ReviewAnnotatorMap.flatten
export const dataUrlBytes = globalThis.ReviewAnnotatorMap.dataUrlBytes
export const snapshotIfSmall = globalThis.ReviewAnnotatorMap.snapshotIfSmall
export const MAX_SNAPSHOT = globalThis.ReviewAnnotatorMap.MAX_SNAPSHOT
