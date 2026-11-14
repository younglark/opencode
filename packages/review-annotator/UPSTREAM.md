# Upstream

Source: [Inginnng/EditHere](https://github.com/Inginnng/EditHere) web app, v0.13.0 at `3dab2c4`.

License: PolyForm Noncommercial 1.0.0 (see `LICENSE` and `NOTICE`). This package is isolated from the MIT-licensed opencode fork on purpose. The EditHere name and logos are not licensed; they are not shown in the shipped UI. Commercial use of this code (including bundling it into a product used for a commercial game project) is an open question and needs a separate license from the author.

Only the web image- and video-annotation sources were copied. Desktop/Qt code, demos, MCP/DSH/agent session tools, marketing assets, and `node_modules` were left out. Icons under `icons/` are the shared Lucide-based set (ISC; their `LICENSE` is preserved).

## Layout

- `upstream/` — copies of `web/src` files, with the patches below.
- `host/` — new adapter code (not upstream): host API, touch, mapping, and browser-only video frame step (no ffmpeg).
- `annotator.html` — build output of `build.mjs` (committed so the review page does not need a generate step).
- `build.mjs` — adapted from `web/build.cjs`: no brand image injection, CSP allows same-origin images, host scripts appended, Required Notice left in an HTML comment. Host scripts' test-only `export const x = globalThis.Y.x` lines are dropped (as classic scripts, two of them re-exporting `frameIndex` was a redeclaration SyntaxError that stopped `host/video.js` from loading).

## Patches in `upstream/`

### `app.js`

- Added host hooks on `EditHereWeb`: `resetAgent`, `viewportFit`, `setZoom`, `changeMode`, `view`, `panBy`, `cancelInteraction`, `loadAgentVideo`, `restoreVideoFrames`, `stepFrame`, `seekTo`, `playPause`, `estimatedFps`, `setFps`, `annotatedFrames`, `sessionKind`, `currentTimestampUs`.
- `releaseVideo` only revokes `blob:` URLs, so a same-origin review asset URL can be used as `video.src`.
- `trackFrames` samples `requestVideoFrameCallback` mediaTime deltas to estimate fps when `Asset.fps` is missing (fallback 30).
- Frame step seeks to the centre of frame `n`, `(n+0.5)/fps`.
- Frame step finds the current frame with `floor(t*fps + 0.25)`, so a presented frame start time that is a little early (recorded WebM: frame 1 at 0.099 s) does not get stuck on the previous frame.
- `prepareVideoUrl` / `attachVideoUrl`: when `video.duration` is `Infinity` (MediaRecorder WebM has no duration in its header), seek far ahead and wait for `durationchange` (at most 3 s) to learn the real duration, then seek back to 0, instead of rejecting the file as "视频时长无效".
- `loadAgentVideo` loads a URL (Range requests come from the video element) and can restore notes onto recaptured frames without storing original video or frame PNGs in the draft.

### `shell.html`

- Title and header text are «标注»; EditHere lockup, icon, and favicon placeholders were removed.
- CSP is `connect-src 'self'`, `img-src 'self' data: blob:`, `media-src 'self' data: blob:`, `frame-ancestors 'self'`.
- The agent script placeholder was replaced by `MAP` / `TOUCH` / `VIDEO` / `HOST`.
- Help footnote no longer points at the desktop product; it mentions shell shortcuts (P/F, J/K) and video frame step (`, .`, space).
- The play bar has previous/next frame buttons (`#frame-prev`, `#frame-next`).

### `help.js`

- Two sentences that named the EditHere desktop app or told the user to “read EditHere feedback” were rewritten so the help text matches this host.

No patches to `feedback.js`, `layout.js`, `detector.js`, `image-format.js`, `bundle.js`, `ui.js`, `style.css`, or `help.css`. The “explode” / layout tools remain in the source but are hidden by `host/host.css`.
