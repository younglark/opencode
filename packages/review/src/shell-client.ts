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
  const formOf = (item) => (item && item.feedback && item.feedback.form) || []
  const answersOf = (item) => ((draft.items && draft.items[item.id]) || {}).answers || {}
  const equalsList = (equals) => (typeof equals === "string" ? [equals] : equals || [])
  const visible = (field, answers) => {
    if (!field.when) return true
    const value = answers && answers[field.when.field]
    const want = equalsList(field.when.equals)
    if (Array.isArray(value)) return value.some((entry) => want.indexOf(entry) >= 0)
    return typeof value === "string" && want.indexOf(value) >= 0
  }
  const visibleFields = (fields, answers) => fields.filter((field) => visible(field, answers))
  const isAnswered = (field, answers) => {
    const value = answers && answers[field.id]
    if (field.type === "multi") return Array.isArray(value) && value.length > 0
    return typeof value === "string" && value.trim() !== ""
  }
  const missingFields = (fields, answers) =>
    visibleFields(fields, answers).filter((field) => field.required && !isAnswered(field, answers))
  const PASS = { pass: 1, ok: 1, yes: 1, "通过": 1 }
  const FAIL = { fail: 1, no: 1, ng: 1, "不通过": 1 }
  const optionPolarity = (option) => {
    const id = String(option.id || "").trim().toLowerCase()
    const label = String(option.label || "").trim()
    const lower = label.toLowerCase()
    if (PASS[id] || PASS[label] || PASS[lower]) return "pass"
    if (FAIL[id] || FAIL[label] || FAIL[lower]) return "fail"
  }
  const isPassFail = (field) => {
    if (field.type !== "choice" || !field.options || field.options.length !== 2) return false
    const polarities = field.options.map(optionPolarity)
    return polarities.indexOf("pass") >= 0 && polarities.indexOf("fail") >= 0
  }
  const passFailField = (fields, answers) => {
    const choices = visibleFields(fields, answers).filter(
      (field) => field.type === "choice" && field.options && field.options.length === 2,
    )
    const natural = choices.find(isPassFail)
    if (natural) return natural
    const required = choices.filter((field) => field.required)
    return required.length === 1 ? required[0] : undefined
  }
  const optionFor = (field, polarity) => {
    if (!field || !field.options) return
    const match = field.options.find((option) => optionPolarity(option) === polarity)
    if (match) return match.id
    if (field.options.length === 2 && !isPassFail(field)) return polarity === "pass" ? field.options[0].id : field.options[1].id
  }
  const itemPolarity = (fields, answers) => {
    const field = visibleFields(fields, answers).find(isPassFail)
    if (!field) return
    const value = answers && answers[field.id]
    if (typeof value !== "string") return
    const option = field.options.find((entry) => entry.id === value)
    return option && optionPolarity(option)
  }
  const itemVerdict = (item) => {
    const saved = (draft.items && draft.items[item.id]) || {}
    if (saved.verdict === "pass" || saved.verdict === "fail") return saved.verdict
    return itemPolarity(formOf(item), saved.answers)
  }
  const statusOf = (item) => {
    const verdict = itemVerdict(item)
    if (verdict) return verdict
    const saved = (draft.items && draft.items[item.id]) || {}
    const input =
      saved.verdict ||
      (saved.text && saved.text.trim()) ||
      saved.custom !== undefined ||
      (saved.answers && Object.keys(saved.answers).length) ||
      (saved.assets &&
        Object.keys(saved.assets).some((id) => {
          const asset = saved.assets[id]
          return (asset.annotations && asset.annotations.length) || asset.raw || (asset.files && asset.files.length)
        }))
    if ((draft.seen && draft.seen[item.id]) || input) return "open"
    return "unread"
  }
  const labels = { unread: "未看", open: "已看", pass: "通过", fail: "不通过" }
  const missing = () => items.filter((item) => missingFields(formOf(item), answersOf(item)).length)
  const completed = () =>
    items.filter((item) => {
      if (missingFields(formOf(item), answersOf(item)).length) return false
      const required = formOf(item).some((field) => field.required)
      return required || !!(draft.seen && draft.seen[item.id])
    }).length
  const toSubmission = () => {
    const result = []
    for (const item of items) {
      const saved = (draft.items && draft.items[item.id]) || {}
      const assets = []
      for (const id of item.assetIDs) {
        const asset = saved.assets && saved.assets[id]
        const annotations = asset && asset.annotations
        if (!asset || (!(annotations && annotations.length) && asset.raw === undefined)) continue
        const entry = { asset: id }
        if (annotations && annotations.length) entry.annotations = annotations
        if (asset.raw !== undefined) entry.raw = asset.raw
        if (asset.files && asset.files.length) entry.files = asset.files
        assets.push(entry)
      }
      const answers = {}
      const current = saved.answers || {}
      for (const field of formOf(item)) {
        if (!visible(field, current)) continue
        const value = current[field.id]
        if (field.type === "multi") {
          if (Array.isArray(value) && value.length) answers[field.id] = value
        } else if (typeof value === "string" && value.trim()) answers[field.id] = field.type === "text" ? value.trim() : value
      }
      const hasAnswers = Object.keys(answers).length > 0
      const custom = item.kind === "custom" ? saved.custom : undefined
      const verdict = item.kind === "custom" && (saved.verdict === "pass" || saved.verdict === "fail") ? saved.verdict : undefined
      const text = item.kind === "custom" && saved.text && saved.text.trim() ? saved.text.trim() : undefined
      if (!hasAnswers && !verdict && !text && assets.length === 0 && custom === undefined) continue
      const entry = { id: item.id }
      if (hasAnswers) entry.answers = answers
      if (verdict) entry.verdict = verdict
      if (text) entry.text = text
      if (assets.length) entry.assets = assets
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
    const judged = items.filter((item) => itemVerdict(item))
    if (judged.length && judged.every((item) => itemVerdict(item) === "pass")) return "continue"
    return draft.decision
  }
  const setPassFail = (item, polarity) => {
    if (!item) return false
    const field = passFailField(formOf(item), answersOf(item))
    if (!field) return false
    const option = optionFor(field, polarity)
    if (!option) return false
    const saved = ensureItem(item.id)
    saved.answers = saved.answers || {}
    saved.answers[field.id] = option
    applySuggest()
    syncForm(item)
    syncNav()
    save()
    return true
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
    syncForm(item)
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
  const HINT = "J / K 切换项 · Ctrl / ⌘ + Enter 提交"
  const HINT_PF = "J / K 切换项 · P / F 通过或不通过 · Ctrl / ⌘ + Enter 提交"
  const syncHint = () => {
    const hint = qs("[data-shortcut-hint]")
    if (!hint) return
    const item = currentItem()
    hint.textContent = item && passFailField(formOf(item), answersOf(item)) ? HINT_PF : HINT
  }
  const syncForm = (item) => {
    const saved = (draft.items && draft.items[item.id]) || {}
    const answers = saved.answers || {}
    const pane = qs('[data-feedback-for="' + CSS.escape(item.id) + '"]')
    if (!pane) return
    const fields = formOf(item)
    qsa("[data-form-field]", pane).forEach((el) => {
      const field = fields.find((entry) => entry.id === el.getAttribute("data-form-field"))
      el.hidden = !!(field && !visible(field, answers))
    })
    qsa("[data-form-option]", pane).forEach((button) => {
      const fieldID = button.getAttribute("data-field")
      const option = button.getAttribute("data-option")
      const field = fields.find((entry) => entry.id === fieldID)
      const value = answers[fieldID]
      if (field && field.type === "multi") pressed(button, Array.isArray(value) && value.indexOf(option) >= 0)
      else pressed(button, value === option)
    })
    qsa("[data-form-text]", pane).forEach((area) => {
      if (area === document.activeElement) return
      const value = answers[area.getAttribute("data-field")]
      area.value = typeof value === "string" ? value : ""
    })
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
    syncHint()
  }

  const measure = () => {
    const bar = qs(".bar")
    const dock = qs(".pane-feedback")
    if (bar) document.documentElement.style.setProperty("--bar", bar.getBoundingClientRect().height + "px")
    if (dock) document.documentElement.style.setProperty("--dock", dock.getBoundingClientRect().height + "px")
  }
  const needsDock = (item) => {
    if (item && item.annotate) return true
    return !!(item && missingFields(formOf(item), answersOf(item)).length)
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
    syncForm(item)
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
      const gaps = missingFields(formOf(left[0]), answersOf(left[0]))
      showError("还有必填项未填写：" + left.map((item) => item.title).join("、"))
      const pane = qs('.item-feedback[data-feedback-for="' + CSS.escape(left[0].id) + '"]')
      const field = gaps[0]
      const gap =
        pane &&
        field &&
        (qs('[data-form-option][data-field="' + CSS.escape(field.id) + '"]', pane) ||
          qs('[data-form-text][data-field="' + CSS.escape(field.id) + '"]', pane))
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
    const option = event.target.closest("[data-form-option]")
    if (!option) return
    const itemID = option.getAttribute("data-item") || currentItem().id
    const item = byId[itemID]
    if (!item) return
    const fieldID = option.getAttribute("data-field")
    const optionID = option.getAttribute("data-option")
    const field = formOf(item).find((entry) => entry.id === fieldID)
    if (!field) return
    const saved = ensureItem(item.id)
    saved.answers = saved.answers || {}
    if (field.type === "multi") {
      const current = Array.isArray(saved.answers[fieldID]) ? saved.answers[fieldID].slice() : []
      const index = current.indexOf(optionID)
      if (index >= 0) current.splice(index, 1)
      else current.push(optionID)
      if (current.length) saved.answers[fieldID] = current
      else delete saved.answers[fieldID]
    } else {
      saved.answers[fieldID] = optionID
    }
    applySuggest()
    syncForm(item)
    syncNav()
    save()
  })

  root.addEventListener("input", (event) => {
    const area = event.target.closest("textarea")
    if (!area) return
    if (area.hasAttribute("data-form-text")) {
      const itemID = area.getAttribute("data-item") || currentItem().id
      const saved = ensureItem(itemID)
      saved.answers = saved.answers || {}
      saved.answers[area.getAttribute("data-field")] = area.value
      const item = byId[itemID]
      if (item) syncForm(item)
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
      setPassFail(item, event.key === "p" || event.key === "P" ? "pass" : "fail")
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
          setPassFail(item, key === "p" || key === "P" ? "pass" : "fail")
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
        setPassFail(item, key === "p" || key === "P" ? "pass" : "fail")
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
