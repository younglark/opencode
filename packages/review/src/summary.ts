export * as ReviewSummary from "./summary.js"

export const PROMPT = [
  "The user stepped away and will review this session from their phone.",
  "Summarize the latest round of work for them in Simplified Chinese, in at most 5 short sentences:",
  "what you did, which files changed, whether it is finished, and anything they need to decide.",
  "Reply with the summary only, no preamble.",
].join(" ")

const LIMIT = 1_200

interface Message {
  readonly type: string
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }> | unknown
}

/** The last assistant text, used when generating a summary fails. */
export function fallback(messages: ReadonlyArray<Message>) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue
    const text = (message.content as ReadonlyArray<{ type: string; text?: string }>)
      .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
      .join("\n")
      .trim()
    if (text !== "") return clip(text)
  }
  return ""
}

export function clip(text: string, limit = LIMIT) {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}
