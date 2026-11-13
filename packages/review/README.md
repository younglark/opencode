# Remote review

`@opencode/review` sends a phone-friendly review link to Feishu and/or WeCom after a root session has sat idle
for a while, and writes the reviewer's decision back into the session.

- `/review-remote <duration>` turns it on with a new idle time (minimum 1 minute, so `30s` is refused; `15m`, `2h`,
  a bare number means minutes). `on` reuses the last duration (default 10 minutes), `off` turns it off, `now`
  sends a link for the current session right away, no argument shows the status.
- Webhooks come only from `OPENCODE_REVIEW_FEISHU_WEBHOOK` and `OPENCODE_REVIEW_WECOM_WEBHOOK`, never from config,
  and are never logged.
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
  refuses to send a link no phone could open; without a webhook it suggests
  `opencode service set env OPENCODE_REVIEW_FEISHU_WEBHOOK <webhook-url>`. Each of these restarts the service.
- `includePairLink` is reserved and stays off; nothing reads it yet.

Build, versioning, sync-from-upstream, and why this fork must not be auto-upgraded to the official
release are documented in [`FORK.md`](../../FORK.md) at the repository root.
