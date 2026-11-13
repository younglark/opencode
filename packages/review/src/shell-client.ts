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
      (saved.assets &&
        Object.keys(saved.assets).some((id) => saved.assets[id].verdict || (saved.assets[id].text && saved.assets[id].text.trim())))
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
        if (!asset || (!asset.verdict && !text)) continue
        const entry = { asset: id }
        if (asset.verdict) entry.verdict = asset.verdict
        if (text) entry.text = text
        assets.push(entry)
      }
      const checks = []
      for (const check of (item.feedback && item.feedback.checks) || []) {
        const verdict = saved.checks && saved.checks[check.id]
        if (verdict) checks.push({ id: check.id, verdict })
      }
      const text = saved.text && saved.text.trim()
      if (!saved.verdict && !text && assets.length === 0 && checks.length === 0) continue
      const entry = { id: item.id }
      if (saved.verdict) entry.verdict = saved.verdict
      if (text) entry.text = text
      if (assets.length) entry.assets = assets
      if (checks.length) entry.checks = checks
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
      const pane = qs(".pane-feedback")
      if (pane) pane.classList.add("open")
      showError("还有必填项未给结论：" + left.map((item) => item.title).join("、"))
      return
    }
    const button = qs("[data-submit]")
    if (button) button.disabled = true
    showError("")
    try {
      const response = await fetch(data.submit, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ t: data.token, result: toSubmission(), files: {} }),
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
      if (button) button.disabled = false
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
      const open = pane && !pane.classList.contains("open")
      if (pane) pane.classList.toggle("open", open)
      handle.setAttribute("aria-expanded", open ? "true" : "false")
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
  const bar = qs(".bar")
  const measure = () => {
    if (bar) document.documentElement.style.setProperty("--bar", bar.getBoundingClientRect().height + "px")
  }
  measure()
  window.addEventListener("resize", measure)

  const start = draft.item && byId[draft.item] ? draft.item : items[0] && items[0].id
  if (start) show(start)
  else syncNav()
})()
`
