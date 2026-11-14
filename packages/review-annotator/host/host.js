// Host adapter (not upstream EditHere code). Talks to the approval shell over postMessage.
(function () {
  const TYPE = {
    ready: "review-annotator:ready",
    load: "review-annotator:load",
    change: "review-annotator:change",
    exportReq: "review-annotator:export",
    exportRes: "review-annotator:exported",
    shortcut: "review-annotator:shortcut",
    error: "review-annotator:error",
  }
  const SHELL_KEYS = new Set(["j", "k", "p", "f"])
  const MapApi = globalThis.ReviewAnnotatorMap
  const Touch = globalThis.ReviewAnnotatorTouch
  const Video = globalThis.ReviewAnnotatorVideo

  document.body.classList.add("review-host")
  document.documentElement.classList.add("review-host")

  const applySystemTheme = () => {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches
    document.documentElement.dataset.theme = dark ? "dark" : "light"
  }
  applySystemTheme()
  const scheme = window.matchMedia("(prefers-color-scheme: dark)")
  if (scheme.addEventListener) scheme.addEventListener("change", applySystemTheme)
  else if (scheme.addListener) scheme.addListener(applySystemTheme)


  const app = () => globalThis.EditHereWeb
  let current = { item: "", asset: "", src: "", name: "", kind: "image", fps: undefined }
  let lastRevision = -1
  let loadToken = 0
  const parentOrigin = () => (window.location.origin && window.location.origin !== "null" ? window.location.origin : "*")

  const post = (message) => {
    if (!window.parent || window.parent === window) return
    window.parent.postMessage(message, parentOrigin())
  }

  const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ""))
      reader.onerror = () => reject(new Error("无法读取图片"))
      reader.readAsDataURL(blob)
    })

  async function fetchImage(src) {
    const response = await fetch(src, { credentials: "same-origin" })
    if (!response.ok) throw new Error("图片加载失败（" + response.status + "）")
    const blob = await response.blob()
    if (!blob.type.startsWith("image/") && blob.type !== "application/octet-stream") {
      throw new Error("资源不是图片")
    }
    return blobToDataUrl(blob)
  }

  function fpsOf() {
    const editor = app()
    const live = editor && typeof editor.estimatedFps === "function" ? editor.estimatedFps() : undefined
    return current.fps || live
  }

  function snapshot() {
    const editor = app()
    if (!editor || !current.src) {
      return { item: current.item, asset: current.asset, annotations: [], raw: undefined }
    }
    let feedback
    try {
      feedback = MapApi.stripImage(editor.feedback())
    } catch (error) {
      feedback = undefined
    }
    const fps = fpsOf()
    if (feedback && current.kind === "video") {
      feedback.fps = fps
      try {
        const project = editor.project?.()
        if (project && Array.isArray(project.frames)) {
          feedback.frameNotes = project.frames.map((frame) => ({
            id: frame.id,
            timestampUs: frame.timestampUs,
            notes: frame.notes,
            layout: frame.layout,
          }))
        }
      } catch (error) {}
      feedback = MapApi.stripImage(feedback)
    }
    const annotations = feedback ? MapApi.annotationsOf(feedback, fps) : []
    return { item: current.item, asset: current.asset, annotations, raw: feedback }
  }

  function reportChange() {
    const editor = app()
    const revision = editor && typeof editor.projectRevision === "function" ? editor.projectRevision() : 0
    if (revision === lastRevision) return
    lastRevision = revision
    post({ type: TYPE.change, ...snapshot() })
  }

  // Render a numbered snapshot by temporarily requesting feedback with preview.
  function renderSnapshot() {
    const editor = app()
    if (!editor) return undefined
    try {
      const list = editor.feedbackForDsh?.()
      const dataUrl = list?.annotated?.[0]?.dataUrl
      return MapApi.snapshotIfSmall(dataUrl)
    } catch (error) {
      // feedbackForDsh throws when there are no marks; that is fine.
      return undefined
    }
  }

  async function load(message) {
    const editor = app()
    if (!editor) throw new Error("标注器还没准备好")
    const token = ++loadToken
    const kind = message.kind === "video" ? "video" : "image"
    current = {
      item: message.item || "",
      asset: message.asset || "",
      src: message.src || "",
      name: message.name || message.asset || "",
      kind,
      fps: message.fps > 0 ? message.fps : undefined,
    }
    lastRevision = -1
    editor.resetAgent?.()
    editor.bindAgent?.()
    const draft = message.draft
    const raw = draft && draft.raw
    if (kind === "video") {
      if (current.fps) editor.setFps?.(current.fps)
      const frames = raw ? MapApi.frameNotes(raw) : []
      await editor.loadAgentVideo({
        src: current.src,
        name: current.name,
        fps: current.fps,
        frames: frames.filter((frame) => Number.isFinite(frame.timestampUs) && (frame.notes || frame.layout)),
      })
      if (current.fps) editor.setFps?.(current.fps)
    } else {
      const dataUrl = await fetchImage(message.src)
      if (token !== loadToken) return
      if (raw && raw.objects) {
        try {
          await editor.loadAgentFeedback({
            name: current.name,
            image: dataUrl,
            feedback: raw,
            imageMode: "none",
            preview: false,
          })
        } catch (error) {
          await editor.loadAgentImage({ name: current.name, image: dataUrl, imageMode: "none", preview: false })
        }
      } else {
        await editor.loadAgentImage({ name: current.name, image: dataUrl, imageMode: "none", preview: false })
      }
    }
    if (token !== loadToken) return
    lastRevision = editor.projectRevision?.() ?? 0
    editor.viewportFit?.()
    post({ type: TYPE.change, ...snapshot() })
  }

  function exportNow(request) {
    const state = snapshot()
    const files = []
    const editor = app()
    if (current.kind === "video" && editor && typeof editor.annotatedFrames === "function") {
      try {
        let used = 0
        for (const frame of editor.annotatedFrames() || []) {
          const dataUrl = MapApi.snapshotIfSmall(frame.dataUrl)
          if (!dataUrl) continue
          const size = MapApi.dataUrlBytes(dataUrl)
          if (used + size > MapApi.MAX_SNAPSHOT) continue
          used += size
          const name = MapApi.frameFileName(state.item, state.asset, frame)
          files.push({ name, dataUrl })
          for (const mark of state.annotations || []) {
            if (mark.frame && mark.frame.timeUs === frame.timestampUs) mark.frame.image = name
          }
        }
      } catch (error) {}
    } else {
      const dataUrl = renderSnapshot()
      if (dataUrl && state.annotations.length)
        files.push({ name: MapApi.fileName(state.item, state.asset), dataUrl })
    }
    post({ type: TYPE.exportRes, request, ...state, file: files[0], files })
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return
    if (parentOrigin() !== "*" && event.origin !== parentOrigin()) return
    const message = event.data
    if (!message || typeof message !== "object") return
    if (message.type === "review-annotator:hello") {
      post({ type: TYPE.ready })
      return
    }
    if (message.type === TYPE.load) {
      load(message).catch((error) =>
        post({ type: TYPE.error, item: message.item, asset: message.asset, message: String(error?.message || error) }),
      )
      return
    }
    if (message.type === TYPE.exportReq) exportNow(message.request)
  })

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.defaultPrevented) return
      const typing = event.target && event.target.closest && event.target.closest("textarea,input,dialog")
      const ctrl = event.ctrlKey || event.metaKey
      if (ctrl && event.key === "Enter") {
        if (typing && event.target.closest("dialog")) return
        event.preventDefault()
        event.stopPropagation()
        post({ type: TYPE.shortcut, key: "Enter", ctrl: true, meta: event.metaKey })
        return
      }
      if (typing || ctrl || event.altKey) return
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
      const editor = app()
      const video = current.kind === "video" || editor?.sessionKind?.() === "video"
      if (video && (key === "," || key === "." || event.key === "，" || event.key === "。")) {
        event.preventDefault()
        event.stopPropagation()
        editor?.stepFrame?.(key === "." || event.key === "。" ? 1 : -1)
        return
      }
      if (video && event.code === "Space") {
        event.preventDefault()
        event.stopPropagation()
        editor?.playPause?.()
        return
      }
      if (key === "g") {
        event.preventDefault()
        event.stopPropagation()
        document.getElementById("global")?.click()
        return
      }
      if (SHELL_KEYS.has(key) || key === "ArrowUp" || key === "ArrowDown") {
        event.preventDefault()
        event.stopPropagation()
        post({ type: TYPE.shortcut, key: event.key, ctrl: false })
      }
    },
    true,
  )

  const start = () => {
    const editor = app()
    if (!editor) {
      setTimeout(start, 20)
      return
    }
    editor.bindAgent?.()
    editor.resetAgent?.()
    if (typeof editor.onProjectChange === "function") editor.onProjectChange(reportChange)
    const viewport = document.getElementById("viewport")
    if (viewport && Touch?.install) Touch.install(editor, viewport)
    post({ type: TYPE.ready })
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start)
  else start()
})()
