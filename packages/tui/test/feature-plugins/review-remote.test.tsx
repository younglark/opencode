import { expect, test } from "bun:test"
import type { ReviewRpc } from "@opencode/review/rpc"
import { resultToast, statusMessage } from "../../src/feature-plugins/prompt/review-remote"
import { createAppFixture } from "../fixture/app"
import { directory, worktree } from "../fixture/tui-client"

const status: ReviewRpc.Status = {
  enabled: true,
  durationMs: 600_000,
  addressesKnown: true,
  lan: null,
  public: null,
  channels: [],
  pending: 0,
  timerAt: null,
  reviewUntil: null,
  hints: [
    {
      level: "warning",
      message: "No address a phone can open.\nSame network: opencode service set hostname 0.0.0.0",
    },
  ],
}

test("a command result toasts its message and, while on, the setup still missing", () => {
  expect(resultToast({ ok: true, message: "Remote review on", status })).toMatchObject({
    title: "Remote review on · idle 10m · no phone address",
    variant: "warning",
    message: expect.stringContaining("opencode service set hostname 0.0.0.0"),
  })
  expect(resultToast({ ok: true, message: "Remote review off", status: { ...status, enabled: false } })).toEqual({
    title: "Remote review off · idle 10m · no phone address",
    message: "Remote review off",
    variant: "success",
    duration: undefined,
  })
  expect(resultToast({ ok: false, message: "Duration must be at least 1m", status })).toMatchObject({
    variant: "error",
    message: "Duration must be at least 1m",
  })
})

test("status text lists the hints and the usage", () => {
  const text = statusMessage({ ...status, pending: 1 }, 0)
  expect(text).toContain("Open review links: 1")
  expect(text).toContain("opencode service set hostname 0.0.0.0")
  expect(text).toContain("Usage: /review-remote")
})

test("/review-remote with no arguments shows status in a dialog, and the footer shows the mode", async () => {
  await using app = await createAppFixture({
    width: 120,
    height: 40,
    fetch: (url) =>
      url.pathname === "/api/rpc/opencode.review/status" ? Response.json({ output: status }) : undefined,
  })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("⇢ review 10m"))
  await app.mockInput.typeText("/review-remote")
  await app.waitForFrame((frame) => frame.includes("/review-remote"))
  // The first Enter picks the completion, which keeps the command in the prompt for its arguments.
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("/review-remote "))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Remote review on · idle 10m · no phone address"))
  expect(app.captureCharFrame()).toContain("opencode service set hostname 0.0.0.0")
})

test("<leader>v runs /review-remote now, which needs a session", async () => {
  await using app = await createAppFixture()
  await app.ready
  await app.waitForFrame((frame) => frame.includes("Ask anything"))
  app.mockInput.pressKey("x", { ctrl: true })
  app.mockInput.pressKey("v")
  await app.waitForFrame((frame) => frame.includes("Open a session first"))
})

test("completion lists /review-remote once although the server also offers it", async () => {
  await using app = await createAppFixture({
    width: 120,
    height: 40,
    fetch: (url) =>
      url.pathname === "/api/command"
        ? Response.json({
            location: { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } },
            data: [
              { name: "review-remote", description: "server twin" },
              { name: "review-other", description: "server only" },
            ],
          })
        : undefined,
  })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("Ask anything"))
  await app.mockInput.typeText("/review-")
  await app.waitForFrame((frame) => frame.includes("/review-other"))
  const frame = app.captureCharFrame()
  expect(frame.split("/review-remote").length - 1).toBe(1)
  expect(frame).not.toContain("server twin")
})
