export * as ReviewCustom from "./custom.js"

/**
 * Host ↔ sandboxed custom-page bridge.
 *
 * Custom items run in an opaque-origin iframe (`sandbox="allow-scripts allow-forms"`, no
 * `allow-same-origin`). The approval page token stays on the shell (`?t=`) and in the
 * asset URL path so relative CSS/JS/images still load. The page does not need privileged
 * APIs: it can `postMessage` the parent, or call the injected `window.opencodeReview` helper.
 *
 * Parent → iframe:
 *   { type: "opencode-review:hello", v: 1, item: string, draft?: { verdict?, text?, custom? } }
 *
 * Iframe → parent:
 *   { type: "opencode-review:ready", v: 1 }
 *   { type: "opencode-review:result", v: 1, result: unknown }
 *   { type: "opencode-review:verdict", v: 1, verdict: "pass" | "fail" }
 *   { type: "opencode-review:text", v: 1, text: string }
 *   { type: "opencode-review:shortcut", v: 1, key: string, ctrl?: boolean }
 *
 * Compatibility shim (not the main API): `__grokbotXPreview.submitFeedback(result)` calls `setResult`.
 */
export const VERSION = 1
export const PREFIX = "opencode-review:"
export const MARKER = "opencode-review-bridge"
/** Max JSON size stored in a draft or accepted on submit, so localStorage stays small. */
export const MAX_JSON = 65_536

export const SCRIPT = [
  "(function(){",
  "var V=1,P='opencode-review:',draft;",
  "function send(msg){if(!window.parent||window.parent===window)return;msg.v=V;window.parent.postMessage(msg,'*');}",
  "function setResult(result){send({type:P+'result',result:result});}",
  "function setVerdict(verdict){if(verdict==='pass'||verdict==='fail')send({type:P+'verdict',verdict:verdict});}",
  "function setText(text){send({type:P+'text',text:text==null?'':String(text)});}",
  "window.opencodeReview={v:V,setResult:setResult,setVerdict:setVerdict,setText:setText,get draft(){return draft;}};",
  "var prev=window.__grokbotXPreview;",
  "window.__grokbotXPreview={submitFeedback:function(result){setResult(result);}};",
  "if(prev&&typeof prev.submitFeedback==='function')window.__grokbotXPreview._prev=prev;",
  "window.addEventListener('message',function(ev){var data=ev.data;if(!data||data.v!==V||data.type!==P+'hello')return;draft=data.draft;try{window.dispatchEvent(new CustomEvent(P+'hello',{detail:data}));}catch(e){}});",
  "document.addEventListener('keydown',function(ev){var ctrl=ev.ctrlKey||ev.metaKey;if(ctrl&&ev.key==='Enter'){ev.preventDefault();send({type:P+'shortcut',key:'Enter',ctrl:true});return;}if(ev.defaultPrevented||ctrl||ev.altKey)return;var el=ev.target;if(el&&el.closest&&el.closest('input,textarea,select,[contenteditable=true]'))return;var key=ev.key;if(key==='j'||key==='J'||key==='k'||key==='K'||key==='p'||key==='P'||key==='f'||key==='F'||key==='ArrowUp'||key==='ArrowDown'){ev.preventDefault();send({type:P+'shortcut',key:key});}},true);",
  "send({type:P+'ready'});",
  "})();",
].join("")

export function isHtml(mime: string | undefined) {
  return typeof mime === "string" && mime.toLowerCase().startsWith("text/html")
}

/** Insert the bridge once, before `</body>` (or `</html>`, or at the end). */
export function inject(html: string) {
  if (html.includes(`id="${MARKER}"`)) return html
  const tag = `<script id="${MARKER}">${SCRIPT}</script>`
  const lower = html.toLowerCase()
  const closeBody = lower.lastIndexOf("</body>")
  if (closeBody >= 0) return html.slice(0, closeBody) + tag + html.slice(closeBody)
  const closeHtml = lower.lastIndexOf("</html>")
  if (closeHtml >= 0) return html.slice(0, closeHtml) + tag + html.slice(closeHtml)
  return html + tag
}

export function clip(value: unknown): unknown | undefined {
  if (value === undefined) return undefined
  try {
    const json = JSON.stringify(value)
    if (typeof json !== "string" || json.length > MAX_JSON) return undefined
    return JSON.parse(json) as unknown
  } catch {
    return undefined
  }
}

export type Incoming =
  | { type: "ready" }
  | { type: "result"; result: unknown }
  | { type: "verdict"; verdict: "pass" | "fail" }
  | { type: "text"; text: string }
  | { type: "shortcut"; key: string; ctrl?: boolean }

export function parse(data: unknown): Incoming | undefined {
  if (!data || typeof data !== "object") return undefined
  const message = data as { type?: unknown; v?: unknown; result?: unknown; verdict?: unknown; text?: unknown; key?: unknown; ctrl?: unknown }
  if (message.v !== VERSION || typeof message.type !== "string" || !message.type.startsWith(PREFIX)) return undefined
  const type = message.type.slice(PREFIX.length)
  if (type === "ready") return { type: "ready" }
  if (type === "result") return { type: "result", result: message.result }
  if (type === "verdict" && (message.verdict === "pass" || message.verdict === "fail"))
    return { type: "verdict", verdict: message.verdict }
  if (type === "text") return { type: "text", text: String(message.text ?? "") }
  if (type === "shortcut" && typeof message.key === "string")
    return { type: "shortcut", key: message.key, ...(message.ctrl ? { ctrl: true } : {}) }
  return undefined
}
