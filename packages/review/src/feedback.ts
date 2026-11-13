export * as ReviewFeedback from "./feedback.js"

import { ReviewState } from "./state.js"

export const MAX_TEXT = 8_000
export const MAX_COMMENTS = 200
export const MAX_FILE = 1_024

export interface Comment {
  readonly file: string
  readonly text: string
}

export function comments(
  input: ReadonlyArray<{ readonly file?: string | null; readonly text?: string | null }>,
): Comment[] {
  const result: Comment[] = []
  for (const item of input) {
    if (result.length >= MAX_COMMENTS) break
    const file = (item.file ?? "").trim().slice(0, MAX_FILE)
    const text = (item.text ?? "").trim().slice(0, MAX_TEXT)
    if (file !== "" && text !== "") result.push({ file, text })
  }
  return result
}

/** Reads `file-0` / `comment-0`, `file-1` / `comment-1`, … from a submitted form. */
export function fromForm(form: { get: (name: string) => string | null }) {
  const input: { file: string | null; text: string | null }[] = []
  for (let index = 0; index < MAX_COMMENTS; index++) {
    const file = form.get(`file-${index}`)
    const text = form.get(`comment-${index}`)
    if (file === null && text === null) break
    input.push({ file, text })
  }
  return comments(input)
}

function block(items: ReadonlyArray<Comment>) {
  if (items.length === 0) return ""
  return ["Comments:", ...items.map((item) => `- ${item.file}:\n  ${item.text}`)].join("\n")
}

/** The prompt written back into the session, or undefined when the decision needs none (stop). */
export function prompt(
  decision: ReviewState.Decision,
  text: string | undefined,
  fileComments: ReadonlyArray<Comment> = [],
) {
  const note = (text ?? "").trim().slice(0, MAX_TEXT)
  const listed = comments(fileComments)
  const extra = block(listed)
  if (decision === "stop") return undefined
  if (decision === "continue") {
    const parts = ["[Remote review] I reviewed your work from my phone. Looks good, please continue."]
    if (note !== "") parts.push("", "Note:", note)
    if (extra !== "") parts.push("", extra)
    return parts.join("\n")
  }
  const parts = ["[Remote review] I reviewed your work from my phone and request these changes:"]
  if (note !== "") parts.push("", note)
  else if (extra === "") parts.push("", "(no details given; re-check your last changes)")
  if (extra !== "") parts.push("", extra)
  return parts.join("\n")
}

export function metadata(reviewID: string, decision: ReviewState.Decision) {
  return { source: ReviewState.FEEDBACK_SOURCE, reviewID, decision }
}
