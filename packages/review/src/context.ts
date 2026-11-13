export * as ReviewContext from "./context.js"

import { ReviewState } from "./state.js"
import { ReviewSummary } from "./summary.js"

const REQUEST_LIMIT = 800
const TURN_LIMIT = 400
const RECENT = 6

export interface Message {
  readonly type: string
  readonly text?: string
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }> | unknown
  readonly metadata?: { readonly source?: unknown } | unknown
}

export interface Turn {
  readonly role: "user" | "assistant"
  readonly text: string
}

export interface Context {
  readonly title: string
  readonly request?: string
  readonly recent: ReadonlyArray<Turn>
}

function source(message: Message) {
  const metadata = message.metadata
  if (!metadata || typeof metadata !== "object" || !("source" in metadata)) return undefined
  return metadata.source
}

function userText(message: Message) {
  if (typeof message.text === "string" && message.text.trim() !== "")
    return ReviewSummary.clip(message.text, REQUEST_LIMIT)
  return undefined
}

function assistantText(message: Message) {
  if (!Array.isArray(message.content)) return undefined
  const text = (message.content as ReadonlyArray<{ type: string; text?: string }>)
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n")
    .trim()
  return text === "" ? undefined : ReviewSummary.clip(text, TURN_LIMIT)
}

/** Session title, the first human request, and the last few user/assistant turns for the approval page. */
export function from(title: string, messages: ReadonlyArray<Message>): Context {
  const turns: Turn[] = []
  let request: string | undefined
  for (const message of messages) {
    if (message.type === "user") {
      if (source(message) === ReviewState.FEEDBACK_SOURCE) continue
      const text = userText(message)
      if (!text) continue
      if (request === undefined) request = text
      turns.push({ role: "user", text: ReviewSummary.clip(text, TURN_LIMIT) })
      continue
    }
    if (message.type !== "assistant") continue
    const text = assistantText(message)
    if (!text) continue
    turns.push({ role: "assistant", text })
  }
  return { title, request, recent: turns.slice(-RECENT) }
}
