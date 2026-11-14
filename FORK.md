# younglark/opencode fork

This fork adds **remote web review** (`/review-remote`) on top of upstream `anomalyco/opencode`. Feature work lives on the `review` branch. Do not publish this tree as an official OpenCode release.

## Version scheme

Use `{upstream version}-review.N`, matching the root `package.json` version plus a fork increment:

```text
2.2.7-review.1
2.2.7-review.2
```

A build with this version is **not** auto-upgraded back to the official channel. `opencode upgrade` is also refused. Update the fork by rebasing and rebuilding, not by running the official installer.

If `OPENCODE_CHANNEL` is unset, a `-review.N` version defaults the update channel to `review` (not `latest`). You can still set `OPENCODE_CHANNEL=review` explicitly when building.

## Sync from upstream

```sh
git fetch upstream
git checkout review
git rebase upstream/dev
# resolve conflicts if any, then:
bun typecheck
# then the package tests you touched, at least:
#   bun test --cwd packages/review
#   bun test --cwd packages/server
```

Use a rebase, not a merge, so the fork commits stay on top of `upstream/dev`. After a rebase, force-push only if this branch is yours and you have agreed to rewrite it (`git push --force-with-lease origin review`).

## Local CLI build (linux x64)

From the repository root, with Bun 1.4.x (see `packageManager` in `package.json`):

```sh
OPENCODE_VERSION=2.2.7-review.1 OPENCODE_CHANNEL=review \
  bun run --cwd packages/cli script/build.ts --single --skip-web-ui

./packages/cli/dist/cli-linux-x64/bin/opencode --version
# expected: 2.2.7-review.1
```

`--single` builds the current platform only (linux x64 on this machine). `--skip-web-ui` skips the desktop/web UI bundle so the compile is faster; the binary still starts and prints the version. Omit `--skip-web-ui` when you need the bundled web app.

`--outdir` can be set if you do not want artifacts under `packages/cli/dist`. `dist/` is gitignored.

## Required environment and service setup

Notification channels are read only from the environment, never from config, and are never logged. Set one or more:

- `OPENCODE_REVIEW_FEISHU_WEBHOOK` (Feishu group bot URL)
- `OPENCODE_REVIEW_WECOM_WEBHOOK` (WeCom group bot URL)
- `OPENCODE_REVIEW_PUSHPLUS_TOKEN` (PushPlus token, personal WeChat, https://www.pushplus.plus/)
- `OPENCODE_REVIEW_SERVERCHAN_KEY` (Server酱 SendKey, `SCT…` for WeChat or `sctp…` for the Server酱³ app, https://sct.ftqq.com/)

The plugin will not change service settings by itself. Status / `now` may hint at these commands, each of which restarts the service:

```sh
opencode service set hostname 0.0.0.0          # LAN address the phone can open
opencode service set remote true                # OpenTunnel public URL
opencode service set env OPENCODE_REVIEW_FEISHU_WEBHOOK <webhook-url>
# and/or
opencode service set env OPENCODE_REVIEW_WECOM_WEBHOOK <webhook-url>
opencode service set env OPENCODE_REVIEW_PUSHPLUS_TOKEN <pushplus-token>
opencode service set env OPENCODE_REVIEW_SERVERCHAN_KEY <sendkey>
```

Then in a session: `/review-remote 10m` (or `on` / `off` / `now`). `<leader>v` (ctrl+x v) runs `now`. `now` refuses to send a link if only loopback addresses are available.

## Remote review: what the review branch adds

Code lives in `packages/review` (MIT, like the rest of opencode) and `packages/review-annotator` (EditHere v0.13.0,
PolyForm Noncommercial 1.0.0, kept in its own package with its LICENSE, NOTICE and UPSTREAM.md; do not move its code
into other packages). Outside those two, the wiring is thin: the server routes in `packages/server/src/review.ts` and
the TUI command in `packages/tui/src/feature-plugins/prompt/review-remote.tsx`. Details are in
[`packages/review/README.md`](packages/review/README.md); in short:

- Idle reviews: `/review-remote <duration>|on|off|now` sends a link after the session sits idle.
- Agent reviews: the `review_request` tool sends a link mid-task. Each request has up to 50 items:
  - `image` and `video`: up to 20 assets each; `feedback.annotate` opens the annotator (boxes, arrows and notes; a
    video mark is tied to a timestamp and frame index, captured in the browser with no ffmpeg).
  - `diff`: the session's file changes, with a pass/fail and comment per file.
  - `custom`: an agent-written HTML page shown in a sandboxed iframe (`allow-scripts allow-forms`, opaque origin).
    Protocol v1 over `postMessage`: the parent sends `opencode-review:hello {v: 1, item, draft}`; the page sends
    `ready`, `result` (JSON, at most 64 KiB), `verdict`, `text` and `shortcut`, or calls the injected
    `window.opencodeReview.setResult/setVerdict/setText`.
  - `feedback` also takes `verdict` (pass/fail) and named `checks`; `wait` is `async` (feedback arrives as a message)
    or `block` (returned as the tool result, with `timeoutMs` and `onTimeout`).
- Links: `/api/review/:id?t=<token>`, one-time 32-byte token (only its sha256 is stored), 2 hour expiry, spent on
  submit. Drafts stay in the phone's `localStorage` until submit.
- Checks: `bun test` in `packages/review` and `packages/review-annotator`, `bun typecheck` at the root, and the
  browser smoke test `bun packages/review/script/smoke.ts` (needs a local Chrome; see the package README).
- Not covered by automated checks: real iOS Safari, Android Chrome and the WeChat / Feishu in-app browsers, and
  delivery through real webhooks. Test those by hand before relying on them.

## Upstream GitHub Actions release workflow

Upstream `.github/workflows/release.yml` is the official release pipeline. It will **not** run usefully on this fork as-is:

- The `plan` job is gated on `github.repository == 'anomalyco/opencode'`.
- Signing and publishing assume the official AWS OIDC role, release environment, Cloudflare R2, npm, Homebrew, and WinGet credentials.

A fork release would need a separate workflow (or a carefully stripped copy): drop the official-repo and official-secrets assumptions, choose a version/channel that will not collide with `latest`, and publish only what you intend (for example a GitHub Release of the linux x64 binary). **Do not run the upstream workflow against this fork**, and do not publish to the official npm package or update endpoints.

## Still needs explicit approval

These are not done by the review-branch work:

- Creating git tags
- Creating GitHub Releases
- Publishing to npm (or any other registry)
- Enabling or running a fork-specific release workflow
