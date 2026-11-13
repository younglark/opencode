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

Webhooks are read only from the environment, never from config, and are never logged:

- `OPENCODE_REVIEW_FEISHU_WEBHOOK`
- `OPENCODE_REVIEW_WECOM_WEBHOOK`

The plugin will not change service settings by itself. Status / `now` may hint at these commands, each of which restarts the service:

```sh
opencode service set hostname 0.0.0.0          # LAN address the phone can open
opencode service set remote true                # OpenTunnel public URL
opencode service set env OPENCODE_REVIEW_FEISHU_WEBHOOK <webhook-url>
# and/or
opencode service set env OPENCODE_REVIEW_WECOM_WEBHOOK <webhook-url>
```

Then in a session: `/review-remote 10m` (or `on` / `off` / `now`). `<leader>v` (ctrl+x v) runs `now`. `now` refuses to send a link if only loopback addresses are available.

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
