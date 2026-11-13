# Remote review

`@opencode/review` sends a phone-friendly review link to Feishu, WeCom and/or personal WeChat (PushPlus, Server酱) after a root session has sat idle
for a while, and writes the reviewer's decision back into the session.

- `/review-remote <duration>` turns it on with a new idle time (minimum 1 minute, so `30s` is refused; `15m`, `2h`,
  a bare number means minutes). `on` reuses the last duration (default 10 minutes), `off` turns it off, `now`
  sends a link for the current session right away, no argument shows the status.
- Channels come only from the environment, never from config, and their URLs, tokens and keys are never logged:
  - `OPENCODE_REVIEW_FEISHU_WEBHOOK`, `OPENCODE_REVIEW_WECOM_WEBHOOK`: group bot webhook URLs.
  - `OPENCODE_REVIEW_PUSHPLUS_TOKEN`: PushPlus token. `POST https://www.pushplus.plus/send` with
    `{token, title, content, template: "html"}`; the reply's `code` must be `200`
    ([docs](https://www.pushplus.plus/doc/guide/api.html)).
  - `OPENCODE_REVIEW_SERVERCHAN_KEY`: Server酱 SendKey. `SCT…` keys post `{title, desp, short}` to
    `https://sctapi.ftqq.com/<key>.send`, `sctp{uid}t…` keys (Server酱³) to `https://<uid>.push.ft07.com/send/<key>.send`;
    the reply's `code` must be `0` ([docs](https://sct.ftqq.com/docs/getting-started/sendkey/)). The link also goes in
    `short`, since WeChat may show only the card. Turbo's free tier allows about 5 messages a day.
  - Reviews that finish together are merged into one message per channel. When both an OpenTunnel and a LAN address
    exist, the WeChat messages carry both links.
- The plugin (this package's default export) owns settings, timers and review records in its plugin storage.
  Timers are stored as absolute deadlines and restored when a Location starts again.
- The server layer (`packages/server/src/review.ts`) owns links and notifications, because only it knows the LAN
  and OpenTunnel URLs, and serves `/api/review/:id` outside the protocol `HttpApi`. Each link carries a one-time
  32-byte token; only its sha256 is stored, it expires after 2 hours and is spent on submit. A submit is refused
  when the session has started another execution since the review opened.
- The TUI (`packages/tui/src/feature-plugins/prompt/review-remote.tsx`) handles `/review-remote` itself through
  this plugin's RPC (`src/rpc.ts`: `status`, `run`, event `changed`): results show as toasts, status as a dialog,
  and `⇢ review <time>` sits beside the prompt while the mode is on. `<leader>v` (ctrl+x v) runs `now`. Other
  clients keep using the server command.
- Status hints what is missing, but never changes service config: with only loopback addresses it suggests
  `opencode service set hostname 0.0.0.0` (LAN) or `opencode service set remote true` (OpenTunnel), and `now`
  refuses to send a link no phone could open; without any channel it suggests
  `opencode service set env <VAR> <value>` for each of the four variables above. Each of these restarts the service.
- Agents start reviews themselves with the `review_request` tool (`src/tool.ts`, request schema in `src/request.ts`),
  mid-task and several per session. Items are `image`, `video`, `diff` and `custom` (an agent-written HTML page shown
  in a sandbox). The built-in kinds take up to 20 assets each, and an item's `feedback` asks for annotations, pass/fail
  per asset, named checks, or a mix. Limits: 50 items; image 30 MB, video 300 MB, other files 20 MB, 1 GB per
  review. Videos should be H.264 MP4: frames are stepped and captured in the browser, with no ffmpeg.
  - Assets are copied when the tool is called (`src/assets.ts`) to `<data>/review/<bundle>/<item>/`, sha256 recorded.
    The server serves them at `/api/review/:id/a/:token/:item/<file>`, ranges included.
  - The agent picks how to wait. `async` returns at once and the feedback arrives as a `[Remote review]` user message.
    `block` returns the feedback, annotated images included, as the tool result. It stops on `timeoutMs` (it reports
    the agent's `onTimeout.plan`, and `link: "close"` ends the link) or when the user stops the session; feedback
    submitted after that still arrives as a message. `send: "with_next_idle"` holds the items for the next idle or `now`
    review.
  - Agent reviews ignore the "session ran again" check and are not closed by typed input. Idle and `now` reviews
    still are.
  - The page submits JSON to `/api/review/:id/submit` (`src/result.ts`: per-item and per-asset verdicts, numbered
    annotations in original pixels, video frame time and index, diff lines; images as data URLs). It is checked against
    the request and saved to `<data>/review/<id>/feedback/` as `feedback.json` plus the images, then delivered to a
    blocked tool call (`src/waiters.ts`) or prompted into the session with up to 12 images attached.
- `includePairLink` is reserved and stays off; nothing reads it yet.

Build, versioning, sync-from-upstream, and why this fork must not be auto-upgraded to the official
release are documented in [`FORK.md`](../../FORK.md) at the repository root.
