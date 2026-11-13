// Host adapter (not upstream EditHere code).
// M7 will add in-browser frame step and capture here. M6 is image-only.
(function (root) {
  const api = { supported: false }
  if (typeof module === "object" && module.exports) module.exports = api
  root.ReviewAnnotatorVideo = api
})(typeof globalThis !== "undefined" ? globalThis : this)
