// Host adapter (not upstream EditHere code).
// Browser-only frame stepping and fps helpers; no ffmpeg.
(function (root, factory) {
  const api = factory()
  if (typeof module === "object" && module.exports) module.exports = api
  root.ReviewAnnotatorVideo = api
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const FALLBACK_FPS = 30

  function frameIndex(timeSec, fps) {
    if (!(fps > 0) || !Number.isFinite(timeSec)) return 0
    return Math.max(0, Math.round(timeSec * fps - 0.5))
  }

  function frameTime(index, fps) {
    if (!(fps > 0)) return 0
    return (Math.max(0, index) + 0.5) / fps
  }

  function stepTime(timeSec, fps, delta, durationSec) {
    const rate = fps > 0 ? fps : FALLBACK_FPS
    const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity
    const index = Math.max(0, frameIndex(timeSec, rate) + (delta || 0))
    const target = frameTime(index, rate)
    const last = Number.isFinite(duration) ? Math.max(0, duration - 1 / rate) : target
    return Math.min(target, last)
  }

  function estimateFps(samples, fallback = FALLBACK_FPS) {
    const rates = (samples || []).filter((value) => value > 1 && value <= 240)
    if (rates.length < 4) return fallback
    const sorted = rates.slice().sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }

  return { FALLBACK_FPS, frameIndex, frameTime, stepTime, estimateFps }
})

export const FALLBACK_FPS = globalThis.ReviewAnnotatorVideo.FALLBACK_FPS
export const frameIndex = globalThis.ReviewAnnotatorVideo.frameIndex
export const frameTime = globalThis.ReviewAnnotatorVideo.frameTime
export const stepTime = globalThis.ReviewAnnotatorVideo.stepTime
export const estimateFps = globalThis.ReviewAnnotatorVideo.estimateFps
