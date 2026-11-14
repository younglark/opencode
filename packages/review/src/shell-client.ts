export const SCRIPT = String.raw`
(() => {
  const dataEl = document.getElementById("review-data")
  if (!dataEl) return
  const data = JSON.parse(dataEl.textContent || "{}")
  const root = document.getElementById("shell")
  if (!root) return
  const storageKey = "opencode.review.draft." + data.id
  const items = data.items || []
  const byId = {}
  for (const item of items) byId[item.id] = item

  const empty = () => ({ v: 1, decision: "continue" })
  const load = () => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || "null")
      if (!value || value.v !== 1) return empty()
      if (value.decision !== "continue" && value.decision !== "changes" && value.decision !== "stop") return empty()
      return value
    } catch (error) {
      return empty()
    }
  }
  let draft = load()

  const save = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(draft))
    } catch (error) {}
  }
  const ensureItem = (id) => {
    draft.items = draft.items || {}
    draft.items[id] = draft.items[id] || {}
    return draft.items[id]
  }
  const assetOf = (id, asset) => {
    const item = ensureItem(id)
    item.assets = item.assets || {}
    item.assets[asset] = item.assets[asset] || {}
    return item.assets[asset]
  }
  const itemVerdict = (item) => {
    const saved = (draft.items && draft.items[item.id]) || {}
    if (saved.verdict) return saved.verdict
    if (!item.feedback || !item.feedback.verdict || item.assetIDs.length === 0) return
    const verdicts = item.assetIDs.map((id) => (saved.assets && saved.assets[id] && saved.assets[id].verdict) || null)
    if (verdicts.some((value) => value === "fail")) return "fail"
    if (verdicts.every((value) => value === "pass")) return "pass"
  }
  const asksVerdict = (item) => !!(item.feedback && (item.feedback.verdict || item.feedback.required))
  const statusOf = (item) => {
    const verdict = itemVerdict(item)
    if (verdict) return verdict
    const saved = (draft.items && draft.items[item.id]) || {}
    const input =
      saved.verdict ||
      (saved.text && saved.text.trim()) ||
      (saved.checks && Object.keys(saved.checks).length) ||
      (saved.custom !== undefined) ||
      (saved.assets &&
        Object.keys(saved.assets).some((id) => {
          const asset = saved.assets[id]
          return asset.verdict || (asset.text && asset.text.trim()) || (asset.annotations && asset.annotations.length) || asset.raw
        }))
    if ((draft.seen && draft.seen[item.id]) || input) return "open"
    return "unread"
  }
  const labels = { unread: "未看", open: "已看", pass: "通过", fail: "不通过" }
  const missing = () => items.filter((item) => item.feedback && item.feedback.required && !itemVerdict(item))
  const completed = () =>
    items.filter((item) => (asksVerdict(item) ? !!itemVerdict(item) : !!(draft.seen && draft.seen[item.id]))).length
  const toSubmission = () => {
    const result = []
    for (const item of items) {
      const saved = (draft.items && draft.items[item.id]) || {}
      const assets = []
      for (const id of item.assetIDs) {
        const asset = saved.assets && saved.assets[id]
        const text = asset && asset.text && asset.text.trim()
        const annotations = asset && asset.annotations
        if (!asset || (!asset.verdict && !text && !(annotations && annotations.length) && asset.raw === undefined)) continue
        const entry = { asset: id }
        if (asset.verdict) entry.verdict = asset.verdict
        if (text) entry.text = text
        if (annotations && annotations.length) entry.annotations = annotations
        if (asset.raw !== undefined) entry.raw = asset.raw
        if (asset.files && asset.files.length) entry.files = asset.files
        assets.push(entry)
      }
      const checks = []
      for (const check of (item.feedback && item.feedback.checks) || []) {
        const verdict = saved.checks && saved.checks[check.id]
        if (verdict) checks.push({ id: check.id, verdict })
      }
      const text = saved.text && saved.text.trim()
      const custom = item.kind === "custom" ? saved.custom : undefined
      if (!saved.verdict && !text && assets.length === 0 && checks.length === 0 && custom === undefined) continue
      const entry = { id: item.id }
      if (saved.verdict) entry.verdict = saved.verdict
      if (text) entry.text = text
      if (assets.length) entry.assets = assets
      if (checks.length) entry.checks = checks
      if (custom !== undefined) entry.custom = custom
      result.push(entry)
    }
    const body = { decision: draft.decision }
    const text = draft.text && draft.text.trim()
    if (text) body.text = text
    if (result.length) body.items = result
    return body
  }
  const suggest = () => {
    if (draft.decision === "stop") return "stop"
    if (items.some((item) => itemVerdict(item) === "fail")) return "changes"
    const judged = items.filter(asksVerdict)
    if (judged.length && judged.every((item) => itemVerdict(item) === "pass")) return "continue"
    return draft.decision
  }

  const origin = location.origin
  const waiting = {}
  const loadWaiting = {}
  const frameOf = (item) => qs('iframe[data-annotator][data-item="' + CSS.escape(item.id) + '"]')
  const fileName = (item, asset) => {
    const part = (value) => String(value || "asset").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_").slice(0, 40) || "asset"
    return part(item) + "-" + part(asset) + ".annotated.png"
  }
  const postFrame = (iframe, message) => {
    if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage(message, origin)
  }
  const loadAnnotator = (item, assetID) => {
    if (!item || !item.annotate) return Promise.resolve()
    const iframe = frameOf(item)
    if (!iframe) return Promise.resolve()
    const asset = assetID || currentAsset(item)
    const src = item.sources && item.sources[asset]
    if (!src) return Promise.resolve()
    const saved = ((draft.items && draft.items[item.id] && draft.items[item.id].assets) || {})[asset]
    const message = {
      type: "review-annotator:load",
      item: item.id,
      asset,
      src,
      name: asset,
      kind: item.kind,
      fps: item.fps && item.fps[asset],
      draft: saved && saved.raw ? { raw: saved.raw } : undefined,
    }
    return new Promise((resolve, reject) => {
      const key = item.id
      if (loadWaiting[key]) {
        clearTimeout(loadWaiting[key].timer)
        loadWaiting[key].resolve()
      }
      const timer = setTimeout(() => {
        delete loadWaiting[key]
        reject(new Error("annotator load timeout"))
      }, 20000)
      const send = () => postFrame(iframe, message)
      loadWaiting[key] = { resolve, reject, timer, asset, send }
      if (iframe.dataset.ready === "1") send()
    })
  }
  const requestExport = (iframe) =>
    new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2)
      const timer = setTimeout(() => {
        delete waiting[id]
        reject(new Error("annotator export timeout"))
      }, 15000)
      waiting[id] = { resolve, reject, timer }
      postFrame(iframe, { type: "review-annotator:export", request: id })
    })
  const storeMarks = (itemID, asset, annotations, raw, files) => {
    if (!itemID || !asset) return
    const saved = assetOf(itemID, asset)
    if (annotations) saved.annotations = annotations
    if (raw !== undefined) saved.raw = raw
    if (files) saved.files = files
    else if (files === undefined && saved.annotations && saved.annotations.length && !saved.annotations.some((mark) => mark.frame))
      saved.files = saved.files || [fileName(itemID, asset)]
    save()
  }

  const annotatorNote = (item, text, bad, link) => {
    const pane = qs('.item-pane[data-item="' + CSS.escape(item.id) + '"]')
    const note = pane && qs("[data-annotator-note]", pane)
    if (!note) return
    note.hidden = !text
    note.classList.toggle("bad", !!bad)
    note.textContent = text || ""
    if (link) {
      const a = document.createElement("a")
      a.href = link
      a.target = "_blank"
      a.rel = "noopener noreferrer"
      a.textContent = "单独打开原文件"
      note.append(" ", a)
    }
  }
  const customFrameOf = (item) => qs('iframe[data-custom][data-item="' + CSS.escape(item.id) + '"]')
  const postCustom = (iframe, message) => {
    if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage(message, "*")
  }
  const helloCustom = (item) => {
    if (!item || item.kind !== "custom") return
    const iframe = customFrameOf(item)
    if (!iframe) return
    const saved = (draft.items && draft.items[item.id]) || {}
    const state = {}
    if (saved.verdict) state.verdict = saved.verdict
    if (saved.text) state.text = saved.text
    if (saved.custom !== undefined) state.custom = saved.custom
    postCustom(iframe, { type: "opencode-review:hello", v: 1, item: item.id, draft: state })
  }
  const storeCustom = (itemID, patch) => {
    const item = byId[itemID]
    if (!item || item.kind !== "custom") return
    const saved = ensureItem(itemID)
    if (patch.verdict === "pass" || patch.verdict === "fail") saved.verdict = patch.verdict
    if (typeof patch.text === "string") saved.text = patch.text
    if (Object.prototype.hasOwnProperty.call(patch, "custom")) {
      try {
        const json = JSON.stringify(patch.custom)
        if (typeof json === "string" && json.length <= 65536) saved.custom = JSON.parse(json)
      } catch (error) {}
    }
    applySuggest()
    syncVerdicts(item)
    syncNav()
    save()
  }

  const qs = (sel, el) => (el || root).querySelector(sel)
  const qsa = (sel, el) => Array.from((el || root).querySelectorAll(sel))
  const currentItem = () => byId[draft.item] || items[0]
  const currentAsset = (item) => {
    draft.asset = draft.asset || {}
    return draft.asset[item.id] || item.assetIDs[0] || ""
  }

  const pressed = (el, on) => {
    if (el) el.setAttribute("aria-pressed", on ? "true" : "false")
  }
  const syncVerdicts = (item) => {
    const saved = (draft.items && draft.items[item.id]) || {}
    const pane = qs('[data-feedback-for="' + CSS.escape(item.id) + '"]')
    const asset = currentAsset(item)
    qsa("[data-verdict]", root).forEach((button) => {
      if (button.getAttribute("data-item") !== item.id) return
      const scope = button.getAttribute("data-scope")
      const value = button.getAttribute("data-verdict")
      if (scope === "item") pressed(button, saved.verdict === value)
      else if (scope === "asset") {
        const id = button.getAttribute("data-asset") || asset
        pressed(button, !!(saved.assets && saved.assets[id] && saved.assets[id].verdict === value))
      } else if (scope === "check") {
        const id = button.getAttribute("data-check")
        pressed(button, !!(saved.checks && saved.checks[id] === value))
      }
    })
    if (pane) {
      qsa("[data-scope='asset-text']", pane).forEach((area) => {
        if (area.getAttribute("data-asset")) return
        if (area !== document.activeElement) area.value = (saved.assets && saved.assets[asset] && saved.assets[asset].text) || ""
      })
    }
    qsa("[data-scope='asset-text'][data-asset]", root).forEach((area) => {
      if (area.getAttribute("data-item") !== item.id) return
      if (area === document.activeElement) return
      const id = area.getAttribute("data-asset")
      area.value = (saved.assets && saved.assets[id] && saved.assets[id].text) || ""
    })
    const itemText = qs("[data-scope='item-text'][data-item='" + CSS.escape(item.id) + "']")
    if (itemText && itemText !== document.activeElement) itemText.value = saved.text || ""
    const label = pane && qs("[data-current-asset]", pane)
    if (label) label.textContent = asset
  }
  const syncNav = () => {
    for (const item of items) {
      const status = statusOf(item)
      const button = qs('.items [data-go="' + CSS.escape(item.id) + '"]')
      if (!button) continue
      button.setAttribute("data-status", status)
      button.setAttribute("aria-current", item.id === (draft.item || "") ? "page" : "false")
      const label = qs(".item-status", button)
      if (label) label.textContent = labels[status]
    }
    const index = Math.max(
      0,
      items.findIndex((item) => item.id === (draft.item || (items[0] && items[0].id))),
    )
    const counter = qs("[data-counter]")
    if (counter) counter.textContent = "第 " + (index + 1) + "/" + items.length + " 项"
    const prev = qs("[data-step='-1']")
    const next = qs("[data-step='1']")
    if (prev) prev.disabled = index <= 0
    if (next) next.disabled = index >= items.length - 1
    const count = qs("[data-progress]")
    if (count) count.textContent = "已完成 " + completed() + "/" + items.length
    qsa("[data-decision]").forEach((button) => pressed(button, button.getAttribute("data-decision") === draft.decision))
    const overall = qs("[data-overall]")
    if (overall && overall !== document.activeElement) overall.value = draft.text || ""
  }

  const measure = () => {
    const bar = qs(".bar")
    const dock = qs(".pane-feedback")
    if (bar) document.documentElement.style.setProperty("--bar", bar.getBoundingClientRect().height + "px")
    if (dock) document.documentElement.style.setProperty("--dock", dock.getBoundingClientRect().height + "px")
  }
  const needsDock = (item) => {
    const feedback = item && item.feedback
    if (!feedback) return false
    return !!(feedback.verdict || feedback.required || (feedback.checks && feedback.checks.length) || item.annotate)
  }
  const setDrawer = (open, manual) => {
    const pane = qs(".pane-feedback")
    const handle = qs("[data-drawer]")
    if (!pane) return
    pane.classList.toggle("open", !!open)
    if (handle) handle.setAttribute("aria-expanded", open ? "true" : "false")
    if (manual) {
      const item = currentItem()
      if (item) {
        draft.drawer = draft.drawer || {}
        draft.drawer[item.id] = open ? "open" : "closed"
        save()
      }
    }
    measure()
  }
  const applyDrawer = (item) => {
    if (!item) return
    const stored = draft.drawer && draft.drawer[item.id]
    if (stored === "open") setDrawer(true)
    else if (stored === "closed") setDrawer(false)
    else setDrawer(needsDock(item))
  }

  const show = (itemID, assetID) => {

    const item = byId[itemID] || items[0]
    if (!item) return
    draft.item = item.id
    draft.seen = draft.seen || {}
    draft.seen[item.id] = true
    draft.asset = draft.asset || {}
    if (assetID) draft.asset[item.id] = assetID
    else if (!draft.asset[item.id]) draft.asset[item.id] = item.assetIDs[0] || ""
    const asset = currentAsset(item)
    qsa(".item-pane").forEach((pane) => {
      pane.hidden = pane.getAttribute("data-item") !== item.id
    })
    qsa(".item-feedback").forEach((pane) => {
      pane.hidden = pane.getAttribute("data-feedback-for") !== item.id
    })
    const pane = qs('.item-pane[data-item="' + CSS.escape(item.id) + '"]')
    if (pane) {
      qsa(".asset-pane", pane).forEach((el) => {
        el.hidden = el.getAttribute("data-asset") !== asset
      })
      qsa("[data-asset-go]", pane).forEach((button) => {
        button.setAttribute("aria-current", button.getAttribute("data-asset-go") === asset ? "true" : "false")
      })
    }
    syncVerdicts(item)
    syncNav()
    save()
    if (item.annotate) {
      annotatorNote(item, "正在载入标注器…")
      loadAnnotator(item, asset).catch((error) => {
        const src = item.sources && item.sources[asset]
        annotatorNote(item, "标注器没能打开这个素材（" + ((error && error.message) || "超时") + "）。仍可写文字意见并提交。", true, src)
      })
    }
    if (item.kind === "custom") helloCustom(item)
    applyDrawer(item)
  }

  const setDecision = (decision) => {
    draft.decision = decision
    syncNav()
    save()
  }
  const applySuggest = () => setDecision(suggest())

  const errorEl = qs("[data-error]")
  const showError = (message) => {
    if (!errorEl) return
    errorEl.hidden = !message
    errorEl.textContent = message || ""
  }

  const outcomes = {
    invalid: { title: "链接无效", body: "这个审查链接无效或已被替换。" },
    used: { title: "已经提交过", body: "这个审查链接已经提交过，不能重复使用。" },
    expired: { title: "链接已过期", body: "这个审查链接已过期。回到电脑上继续，或在会话里运行 /review-remote now 重新发送。" },
    continued: { title: "已在电脑端继续", body: "这个会话在你打开链接之后已经在电脑上继续了，手机端的反馈不会再写回。" },
    continue: { title: "已提交", body: "已通知 agent 继续。" },
    changes: { title: "已提交", body: "已把修改意见发给 agent，它会接着改。" },
    stop: { title: "已提交", body: "已记录：先停下。会话保持空闲，回到电脑后再处理。" },
  }
  const paint = (kind, fallback) => {
    const message = outcomes[kind] || fallback || { title: "提交失败", body: "反馈没能写回会话，请稍后重试。" }
    const tone = kind === "continue" || kind === "changes" || kind === "stop" ? "ok" : kind === "invalid" ? "bad" : "warn"
    document.body.innerHTML =
      '<section class="card state ' + tone + '"><h1>' + message.title + "</h1><p>" + message.body + "</p></section>"
  }

  const submit = async () => {
    const left = missing()
    if (left.length) {
      show(left[0].id)
      setDrawer(true, true)
      showError("还有必填项未给结论：" + left.map((item) => item.title).join("、"))
      const gap = qs('.item-feedback[data-feedback-for="' + CSS.escape(left[0].id) + '"] [data-verdict]')
      if (gap && gap.focus) gap.focus()
      return
    }
    const button = qs("[data-submit]")
    if (button) {
      button.disabled = true
      button.setAttribute("aria-busy", "true")
      button.textContent = "提交中…"
    }
    showError("")
    try {
      const files = {}
      for (const item of items) {
        if (!item.annotate) continue
        const iframe = frameOf(item)
        if (!iframe) continue
        const saved = (draft.items && draft.items[item.id] && draft.items[item.id].assets) || {}
        for (const id of item.assetIDs) {
          const asset = saved[id]
          if (!asset || (!(asset.annotations && asset.annotations.length) && asset.raw === undefined)) continue
          try {
            await loadAnnotator(item, id)
            const exported = await requestExport(iframe)
            const uploads = Array.isArray(exported.files) && exported.files.length ? exported.files : exported.file ? [exported.file] : []
            const names = uploads.filter((file) => file && file.name && file.dataUrl).map((file) => file.name)
            storeMarks(item.id, id, exported.annotations, exported.raw, names)
            for (const file of uploads) if (file && file.name && file.dataUrl) files[file.name] = file.dataUrl
          } catch (error) {}
        }
      }
      if (data.preview) {
        try {
          localStorage.removeItem(storageKey)
        } catch (error) {}
        paint(draft.decision)
        const home = document.createElement("p")
        home.className = "muted"
        home.style.textAlign = "center"
        home.innerHTML = '<a href="index.html">返回预览首页</a>'
        document.body.appendChild(home)
        return
      }
      const response = await fetch(data.submit, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ t: data.token, result: toSubmission(), files }),
      })
      const body = await response.json().catch(() => ({}))
      if (response.ok && body.ok) {
        try {
          localStorage.removeItem(storageKey)
        } catch (error) {}
        paint(draft.decision)
        return
      }
      if (body.error && outcomes[body.error]) {
        paint(body.error)
        return
      }
      showError(
        body.error === "the feedback could not be written back; try again"
          ? "提交失败，请重试。草稿仍在。"
          : body.error || "提交失败，请重试。草稿仍在。",
      )
    } catch (error) {
      showError("网络出错，请重试。草稿仍在。")
    } finally {
      if (button) {
        button.disabled = false
        button.removeAttribute("aria-busy")
        button.textContent = "提交全部"
      }
    }
  }

  const typing = (el) => el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")

  root.addEventListener("click", (event) => {
    const go = event.target.closest("[data-go]")
    if (go) return show(go.getAttribute("data-go"))
    const assetGo = event.target.closest("[data-asset-go]")
    if (assetGo) return show(currentItem().id, assetGo.getAttribute("data-asset-go"))
    const step = event.target.closest("[data-step]")
    if (step) {
      const index = items.findIndex((item) => item.id === currentItem().id) + Number(step.getAttribute("data-step"))
      if (items[index]) show(items[index].id)
      return
    }
    const handle = event.target.closest("[data-drawer]")
    if (handle) {
      const pane = qs(".pane-feedback")
      setDrawer(pane && !pane.classList.contains("open"), true)
      return
    }
    const decision = event.target.closest("[data-decision]")
    if (decision) return setDecision(decision.getAttribute("data-decision"))
    const submitBtn = event.target.closest("[data-submit]")
    if (submitBtn) return void submit()
    const verdict = event.target.closest("[data-verdict]")
    if (!verdict) return
    const itemID = verdict.getAttribute("data-item") || currentItem().id
    const item = byId[itemID]
    if (!item) return
    const value = verdict.getAttribute("data-verdict")
    const scope = verdict.getAttribute("data-scope")
    if (scope === "item") ensureItem(item.id).verdict = value
    else if (scope === "check") {
      const saved = ensureItem(item.id)
      saved.checks = saved.checks || {}
      saved.checks[verdict.getAttribute("data-check")] = value
    } else {
      const asset = verdict.getAttribute("data-asset") || currentAsset(item)
      if (asset) assetOf(item.id, asset).verdict = value
    }
    applySuggest()
    syncVerdicts(item)
    syncNav()
    save()
  })

  root.addEventListener("input", (event) => {
    const area = event.target.closest("textarea")
    if (!area) return
    const scope = area.getAttribute("data-scope")
    if (scope === "item-text") ensureItem(area.getAttribute("data-item")).text = area.value
    else if (scope === "asset-text") {
      const itemID = area.getAttribute("data-item") || currentItem().id
      const asset = area.getAttribute("data-asset") || currentAsset(byId[itemID])
      if (asset) assetOf(itemID, asset).text = area.value
    } else if (area.hasAttribute("data-overall")) draft.text = area.value
    save()
  })

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || typing(event.target)) return
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault()
      return void submit()
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const item = currentItem()
    if (event.key === "j" || event.key === "J" || event.key === "ArrowDown" || event.key === "ArrowRight") {
      const index = items.findIndex((entry) => entry.id === item.id) + 1
      if (items[index]) show(items[index].id)
    } else if (event.key === "k" || event.key === "K" || event.key === "ArrowUp" || event.key === "ArrowLeft") {
      const index = items.findIndex((entry) => entry.id === item.id) - 1
      if (items[index]) show(items[index].id)
    } else if (event.key === "p" || event.key === "P" || event.key === "f" || event.key === "F") {
      const value = event.key === "p" || event.key === "P" ? "pass" : "fail"
      if (item.feedback && item.feedback.verdict && item.assetIDs.length) assetOf(item.id, currentAsset(item)).verdict = value
      else ensureItem(item.id).verdict = value
      applySuggest()
      syncVerdicts(item)
      syncNav()
      save()
    }
  })

  window.addEventListener("message", (event) => {
    const message = event.data
    if (!message || typeof message !== "object" || typeof message.type !== "string") return
    if (message.type.startsWith("opencode-review:")) {
      if (message.v !== 1) return
      const iframe = qsa("iframe[data-custom]").find((frame) => frame.contentWindow === event.source)
      if (!iframe) return
      if (event.origin !== "null" && event.origin !== origin) return
      const itemID = iframe.getAttribute("data-item")
      if (message.type === "opencode-review:ready") {
        const item = byId[itemID]
        if (item) helloCustom(item)
        return
      }
      if (message.type === "opencode-review:result") {
        storeCustom(itemID, { custom: message.result })
        return
      }
      if (message.type === "opencode-review:verdict") {
        storeCustom(itemID, { verdict: message.verdict })
        return
      }
      if (message.type === "opencode-review:text") {
        storeCustom(itemID, { text: message.text })
        return
      }
      if (message.type === "opencode-review:shortcut") {
        const key = message.key
        if (message.ctrl && key === "Enter") return void submit()
        const item = currentItem()
        if (!item) return
        if (key === "j" || key === "J" || key === "ArrowDown") {
          const index = items.findIndex((entry) => entry.id === item.id) + 1
          if (items[index]) show(items[index].id)
        } else if (key === "k" || key === "K" || key === "ArrowUp") {
          const index = items.findIndex((entry) => entry.id === item.id) - 1
          if (items[index]) show(items[index].id)
        } else if (key === "p" || key === "P" || key === "f" || key === "F") {
          const value = key === "p" || key === "P" ? "pass" : "fail"
          if (item.feedback && item.feedback.verdict && item.assetIDs.length) assetOf(item.id, currentAsset(item)).verdict = value
          else ensureItem(item.id).verdict = value
          applySuggest()
          syncVerdicts(item)
          syncNav()
          save()
        }
      }
      return
    }
    if (event.origin !== origin) return
    if (!message.type.startsWith("review-annotator:")) return
    if (message.type === "review-annotator:ready") {
      const iframe = qsa("iframe[data-annotator]").find((frame) => frame.contentWindow === event.source)
      if (!iframe) return
      iframe.dataset.ready = "1"
      const item = byId[iframe.getAttribute("data-item")]
      const waiter = item && loadWaiting[item.id]
      if (waiter && waiter.send) waiter.send()
      else if (item && item.annotate && currentItem() && currentItem().id === item.id) void loadAnnotator(item, currentAsset(item))
      return
    }
    if (message.type === "review-annotator:error") {
      const iframe = qsa("iframe[data-annotator]").find((frame) => frame.contentWindow === event.source)
      const item = iframe && byId[iframe.getAttribute("data-item")]
      if (!item) return
      const waiter = loadWaiting[item.id]
      if (waiter) {
        clearTimeout(waiter.timer)
        delete loadWaiting[item.id]
        waiter.reject(new Error(String(message.message || "加载失败")))
      } else {
        annotatorNote(item, "标注器出错：" + String(message.message || "未知错误"), true)
      }
      return
    }
    if (message.type === "review-annotator:change") {
      storeMarks(message.item, message.asset, message.annotations, message.raw)
      if (byId[message.item]) annotatorNote(byId[message.item], "")
      const waiter = loadWaiting[message.item]
      if (waiter && waiter.asset === message.asset) {
        clearTimeout(waiter.timer)
        delete loadWaiting[message.item]
        waiter.resolve()
      }
      const item = byId[message.item]
      if (item) {
        syncNav()
      }
      return
    }
    if (message.type === "review-annotator:exported") {
      const waiter = waiting[message.request]
      if (!waiter) return
      clearTimeout(waiter.timer)
      delete waiting[message.request]
      waiter.resolve(message)
      return
    }
    if (message.type === "review-annotator:shortcut") {
      const key = message.key
      if (message.ctrl && key === "Enter") return void submit()
      const item = currentItem()
      if (!item) return
      if (key === "j" || key === "J" || key === "ArrowDown") {
        const index = items.findIndex((entry) => entry.id === item.id) + 1
        if (items[index]) show(items[index].id)
      } else if (key === "k" || key === "K" || key === "ArrowUp") {
        const index = items.findIndex((entry) => entry.id === item.id) - 1
        if (items[index]) show(items[index].id)
      } else if (key === "p" || key === "P" || key === "f" || key === "F") {
        const value = key === "p" || key === "P" ? "pass" : "fail"
        if (item.feedback && item.feedback.verdict && item.assetIDs.length) assetOf(item.id, currentAsset(item)).verdict = value
        else ensureItem(item.id).verdict = value
        applySuggest()
        syncVerdicts(item)
        syncNav()
        save()
      }
    }
  })
  qsa("iframe[data-annotator]").forEach((iframe) => {
    iframe.addEventListener("load", () => postFrame(iframe, { type: "review-annotator:hello" }))
  })
  qsa("iframe[data-custom]").forEach((iframe) => {
    iframe.addEventListener("load", () => {
      const item = byId[iframe.getAttribute("data-item")]
      if (item) helloCustom(item)
    })
  })

  const viewport = window.visualViewport
  if (viewport) {
    const sync = () => {
      document.documentElement.style.setProperty(
        "--vv",
        Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) + "px",
      )
    }
    viewport.addEventListener("resize", sync)
    viewport.addEventListener("scroll", sync)
    sync()
  }
  measure()
  window.addEventListener("resize", measure)
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(measure)
    const bar = qs(".bar")
    const dock = qs(".pane-feedback")
    if (bar) observer.observe(bar)
    if (dock) observer.observe(dock)
  }

  const start = draft.item && byId[draft.item] ? draft.item : items[0] && items[0].id
  if (start) show(start)
  else syncNav()
})()
`
