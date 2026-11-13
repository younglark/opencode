export * as ReviewAnnotator from "./annotator.js"

import fs from "node:fs"
import path from "node:path"

/** Same-origin page the approval shell loads in an iframe for image annotation. */
export const route = (reviewID: string, token: string) =>
  `/api/review/${encodeURIComponent(reviewID)}/annotator?t=${encodeURIComponent(token)}`

const file = path.join(import.meta.dir, "../../review-annotator/annotator.html")

/** The built annotator document, PolyForm Noncommercial, kept in the isolated package. */
export const html = () => fs.readFileSync(file, "utf8")
