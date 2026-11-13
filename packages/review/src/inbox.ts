export * as ReviewInbox from "./inbox.js"

import { ReviewState } from "./state.js"

type Item = { readonly type: string; readonly payload?: object }

/** Only input a person typed counts: synthetic notices, compaction, moves and our own feedback do not. */
export function isHumanInput(item: Item) {
  if (item.type !== "user") return false
  const metadata = item.payload && "metadata" in item.payload ? item.payload.metadata : undefined
  const source = metadata && typeof metadata === "object" && "source" in metadata ? metadata.source : undefined
  return source !== ReviewState.FEEDBACK_SOURCE
}
