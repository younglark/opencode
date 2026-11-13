// Host adapter (not upstream EditHere code). Two-finger pinch/pan on the viewport.
(function (root) {
  function distance(a, b) {
    const dx = a.clientX - b.clientX
    const dy = a.clientY - b.clientY
    return Math.hypot(dx, dy)
  }
  function midpoint(a, b) {
    return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 }
  }

  function install(api, viewport) {
    const pointers = new Map()
    let pinch = null

    const list = () => [...pointers.values()]

    const onDown = (event) => {
      if (event.pointerType !== "touch" && event.pointerType !== "pen") return
      pointers.set(event.pointerId, event)
      if (pointers.size === 2) {
        api.cancelInteraction?.()
        const pts = list()
        const view = api.view?.() || { zoom: 1, panX: 0, panY: 0 }
        const mid = midpoint(pts[0], pts[1])
        pinch = {
          startDist: Math.max(1, distance(pts[0], pts[1])),
          startZoom: view.zoom,
          lastMid: mid,
        }
        event.preventDefault()
        event.stopPropagation()
      }
    }

    const onMove = (event) => {
      if (!pointers.has(event.pointerId)) return
      pointers.set(event.pointerId, event)
      if (!pinch || pointers.size < 2) return
      const pts = list()
      const dist = Math.max(1, distance(pts[0], pts[1]))
      const mid = midpoint(pts[0], pts[1])
      api.setZoom?.(pinch.startZoom * (dist / pinch.startDist), mid)
      const dx = mid.clientX - pinch.lastMid.clientX
      const dy = mid.clientY - pinch.lastMid.clientY
      if (dx || dy) api.panBy?.(dx, dy)
      pinch.lastMid = mid
      event.preventDefault()
      event.stopPropagation()
    }

    const onUp = (event) => {
      pointers.delete(event.pointerId)
      if (pointers.size < 2) pinch = null
    }

    const opts = { capture: true, passive: false }
    viewport.addEventListener("pointerdown", onDown, opts)
    viewport.addEventListener("pointermove", onMove, opts)
    viewport.addEventListener("pointerup", onUp, opts)
    viewport.addEventListener("pointercancel", onUp, opts)
    viewport.addEventListener(
      "touchmove",
      (event) => {
        if (pinch) event.preventDefault()
      },
      { passive: false },
    )
    return () => {
      viewport.removeEventListener("pointerdown", onDown, opts)
      viewport.removeEventListener("pointermove", onMove, opts)
      viewport.removeEventListener("pointerup", onUp, opts)
      viewport.removeEventListener("pointercancel", onUp, opts)
    }
  }

  // Pure pinch math, tested without a DOM.
  function nextZoom(startZoom, startDist, currentDist, min = 0.00001, max = 16) {
    const zoom = startZoom * (Math.max(1, currentDist) / Math.max(1, startDist))
    return Math.min(max, Math.max(min, zoom))
  }

  const api = { install, distance, midpoint, nextZoom }
  if (typeof module === "object" && module.exports) module.exports = api
  root.ReviewAnnotatorTouch = api
})(typeof globalThis !== "undefined" ? globalThis : this)

export const install = globalThis.ReviewAnnotatorTouch.install
export const distance = globalThis.ReviewAnnotatorTouch.distance
export const midpoint = globalThis.ReviewAnnotatorTouch.midpoint
export const nextZoom = globalThis.ReviewAnnotatorTouch.nextZoom
