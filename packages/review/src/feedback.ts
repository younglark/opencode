export * as ReviewFeedback from "./feedback.js"

import { ReviewState } from "./state.js"

export const MAX_TEXT = 8_000

/** The prompt written back into the session, or undefined when the decision needs none (stop). */
export function prompt(decision: ReviewState.Decision, text: string | undefined) {
  const note = (text ?? "").trim().slice(0, MAX_TEXT)
  if (decision === "stop") return undefined
  if (decision === "continue")
    return note === ""
      ? "[Remote review] I reviewed your work from my phone. Looks good, please continue."
      : `[Remote review] I reviewed your work from my phone. Looks good, please continue.\n\nNote:\n${note}`
  return `[Remote review] I reviewed your work from my phone and request these changes:\n\n${note === "" ? "(no details given; re-check your last changes)" : note}`
}

export function metadata(reviewID: string, decision: ReviewState.Decision) {
  return { source: ReviewState.FEEDBACK_SOURCE, reviewID, decision }
}
