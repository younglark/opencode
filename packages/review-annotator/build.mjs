// Builds a single-file annotator.html. Adapted from EditHere web/build.cjs;
// no bundler, no runtime dependencies. Host scripts are ours; upstream sources
// live in ./upstream and icons in ./icons.
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"

const dir = path.dirname(fileURLToPath(import.meta.url))
const iconDirectory = path.join(dir, "icons")
const iconManifest = JSON.parse(fs.readFileSync(path.join(iconDirectory, "manifest.json"), "utf8"))
if (
  iconManifest.schemaVersion !== 1 ||
  !iconManifest.icons?.length ||
  iconManifest.style?.viewBox !== "0 0 24 24" ||
  iconManifest.style?.strokeWidth !== 2 ||
  iconManifest.style?.linecap !== "round" ||
  iconManifest.style?.linejoin !== "round"
)
  throw new Error("Unsupported shared icon manifest or visual style")

const iconIds = new Set()
const symbols = iconManifest.icons
  .map((icon) => {
    if (!/^[a-z][a-z0-9-]*$/.test(icon.id) || iconIds.has(icon.id))
      throw new Error("Invalid or duplicate shared icon ID: " + icon.id)
    if (!/^icons\/[a-z0-9-]+\.svg$/.test(icon.file)) throw new Error("Invalid shared icon path: " + icon.file)
    iconIds.add(icon.id)
    const source = fs
      .readFileSync(path.join(iconDirectory, icon.file), "utf8")
      .replace(/<\?xml[\s\S]*?\?>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim()
    const match = source.match(/^<svg\b([^>]*)>([\s\S]*?)<\/svg>$/)
    if (!match || !/\bviewBox=["']0 0 24 24["']/.test(match[1]))
      throw new Error("Shared icon must use a 24 × 24 viewBox: " + icon.id)
    const body = match[2].trim()
    if (
      !body ||
      /<\/?(?!path\b|rect\b|circle\b|ellipse\b|line\b|polyline\b|polygon\b|g\b)[a-z]/i.test(body) ||
      /\b(?:href|style|on[a-z]+)\s*=/i.test(body) ||
      /url\s*\(/i.test(body)
    )
      throw new Error("Shared icon contains unsupported SVG content: " + icon.id)
    return `<symbol id="i-${icon.id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`
  })
  .join("\n")

for (const folder of ["upstream", "host"]) {
  for (const file of fs.readdirSync(path.join(dir, folder)).filter((name) => /\.(?:html|js)$/.test(name))) {
    const source = fs.readFileSync(path.join(dir, folder, file), "utf8")
    const references = [
      ...source.matchAll(/#i-([a-z][a-z0-9-]*)/g),
      ...source.matchAll(/\b(?:icon|card)\(\s*['"]([a-z][a-z0-9-]*)['"]/g),
    ]
    for (const reference of references)
      if (!iconIds.has(reference[1])) throw new Error("Unknown shared icon in " + file + ": " + reference[1])
  }
}

const version = "0.13.0"
let html = fs.readFileSync(path.join(dir, "upstream/shell.html"), "utf8")
html = html.replace("/*__VERSION__*/", version)
html = html.replace("/*__UI_ICONS__*/", () => symbols)
const iconLicense = fs.readFileSync(path.join(iconDirectory, "LICENSE"), "utf8").trim()
if (iconLicense.includes("-->")) throw new Error("Shared icon license cannot be embedded in an HTML comment")
html = html.replace("/*__UI_ICON_LICENSE__*/", () => iconLicense)

const sources = [
  ["STYLE", "upstream/style.css"],
  ["LAYOUT", "upstream/layout.js"],
  ["IMAGE_FORMAT", "upstream/image-format.js"],
  ["FEEDBACK", "upstream/feedback.js"],
  ["BUNDLE", "upstream/bundle.js"],
  ["DETECTOR", "upstream/detector.js"],
  ["HELP", "upstream/help.js"],
  ["UI", "upstream/ui.js"],
  ["APP", "upstream/app.js"],
  ["MAP", "host/map.js"],
  ["TOUCH", "host/touch.js"],
  ["VIDEO", "host/video.js"],
  ["HOST", "host/host.js"],
]

for (const [name, file] of sources) {
  let source = fs.readFileSync(path.join(dir, file), "utf8")
  if (name === "STYLE") {
    source += "\n" + fs.readFileSync(path.join(dir, "upstream/help.css"), "utf8")
    source += "\n" + fs.readFileSync(path.join(dir, "host/host.css"), "utf8")
  } else {
    // Host modules end with test-only ESM re-exports of their global (`export const x = globalThis.Y.x`).
    // Drop them: as classic scripts sharing one global scope, two modules re-exporting the same name
    // (map.js and video.js both have frameIndex) would be a redeclaration SyntaxError that kills the script.
    source = source.replace(/^export const \w+ = globalThis\.\w+\.\w+;?\s*$/gm, "")
    if (/^export /m.test(source)) throw new Error("Unexpected ESM export in " + file)
    new vm.Script(source, { filename: file })
  }
  html = html.replace("/*__" + name + "__*/", () => source.replace(/<\/script/gi, "<\\/script"))
}

if (/\/\*__[A-Z_]+__\*\//.test(html)) throw new Error("Unresolved asset or source placeholder")

const notice = fs.readFileSync(path.join(dir, "NOTICE"), "utf8").trim()
if (notice.includes("-->")) throw new Error("NOTICE cannot be embedded in an HTML comment")
const banner = `<!--\nRequired Notice: Copyright 2026 Inginnng (https://github.com/Inginnng/EditHere)\n\nThis file is a modified copy of the EditHere web app (v${version}), shipped as part of\nopencode remote review under the PolyForm Noncommercial License 1.0.0.\nSee packages/review-annotator/LICENSE and NOTICE.\n\n${notice}\n-->\n`

const output = banner + html
const dest = path.join(dir, "annotator.html")
fs.writeFileSync(dest, output)
console.log("Built " + dest + " (" + Buffer.byteLength(output) + " bytes)")
