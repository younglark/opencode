import { describe, expect } from "bun:test"
import { Effect, Layer, Schedule } from "effect"
import { LanguageModel } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { ReviewBridge, ReviewFeedback, ReviewState } from "@opencode/review"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const llmLayer = TestLLM.testLayer({ fallback: TestLLM.text("Renamed the parser and added tests.", "work") })
const it = testEffect(
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(LayerNode.group([Session.node, LocationServiceMap.node, Job.node, KV.node]), [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      LayerNodePlatform.llmClient.replace(llmLayer),
      SessionRunnerModel.node.replace(
        Layer.succeed(SessionRunnerModel.Service, {
          resolve: () =>
            Effect.succeed(
              SessionRunnerModel.resolved(
                LanguageModel.make({ id: "review", provider: "test", route: OpenAIChat.route }),
                {
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  cost: [],
                  limit: { context: 200_000, output: 32_000 },
                },
              ),
            ),
        }),
      ),
    ]),
  ),
)

const model = Model.Ref.make({ id: Model.ID.make("review"), providerID: Provider.ID.make("test") })
const store = KV.Service.use((kv) => Effect.succeed(PluginHost.storage(kv, ReviewState.PLUGIN_ID)))
const read = (key: string) => store.pipe(Effect.flatMap((storage) => storage.get(key)))

function eventually<A, R>(effect: Effect.Effect<A, unknown, R>, done: (value: A) => boolean) {
  return effect.pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("10 millis") }),
    Effect.timeout("10 seconds"),
    Effect.orDie,
  )
}

function project() {
  return Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const sessions = yield* Session.Service
    return yield* sessions.create({
      location: { directory: AbsolutePath.make(tmp.path) },
      title: "Review session",
      agent: Agent.ID.make("build"),
      model,
    })
  })
}

describe("remote review plugin", () => {
  it.live("arms a stored deadline when a session finishes and cancels it on typed input", () =>
    Effect.gen(function* () {
      const session = yield* project()
      const sessions = yield* Session.Service
      yield* sessions.command({ sessionID: session.id, command: "review-remote", text: "15m" })
      expect(ReviewState.settings(yield* read(ReviewState.SETTINGS_KEY))).toEqual({
        enabled: true,
        durationMs: 15 * 60_000,
      })

      const before = Date.now()
      yield* sessions.prompt({ sessionID: session.id, text: "Rename the parser" })
      yield* sessions.wait(session.id)
      const timer = ReviewState.timer(
        yield* eventually(read(ReviewState.TIMER_PREFIX + session.id), (value) => value !== undefined),
      )!
      expect(timer.deadline).toBeGreaterThanOrEqual(before + 15 * 60_000)
      expect(timer.deadline).toBeLessThanOrEqual(Date.now() + 15 * 60_000)

      yield* sessions.prompt({ sessionID: session.id, text: "Actually, also update the docs" })
      yield* eventually(read(ReviewState.TIMER_PREFIX + session.id), (value) => value === undefined)
      yield* sessions.wait(session.id)
      yield* sessions.command({ sessionID: session.id, command: "review-remote", text: "off" })
      yield* eventually(read(ReviewState.TIMER_PREFIX + session.id), (value) => value === undefined)
    }),
  )

  it.live("/review-remote now summarizes, publishes a link, and our own feedback does not supersede it", () =>
    Effect.gen(function* () {
      const published: ReviewBridge.Ready[] = []
      const unregister = ReviewBridge.register((review) => published.push(review))
      yield* Effect.addFinalizer(() => Effect.sync(unregister))
      const session = yield* project()
      const sessions = yield* Session.Service
      yield* sessions.prompt({ sessionID: session.id, text: "Rename the parser" })
      yield* sessions.wait(session.id)

      yield* sessions.command({ sessionID: session.id, command: "review-remote", text: "now" })
      expect(published).toHaveLength(1)
      expect(published[0]).toMatchObject({ sessionID: session.id, title: "Review session" })
      expect(published[0].summary).toBe("Renamed the parser and added tests.")
      const reviewID = published[0].reviewID
      expect(ReviewState.review(yield* read(ReviewState.REVIEW_PREFIX + reviewID))?.status).toBe("open")

      yield* sessions.prompt({
        sessionID: session.id,
        text: "feedback",
        metadata: ReviewFeedback.metadata(reviewID, "continue"),
      })
      yield* sessions.wait(session.id)
      expect(ReviewState.review(yield* read(ReviewState.REVIEW_PREFIX + reviewID))?.status).toBe("open")

      yield* sessions.prompt({ sessionID: session.id, text: "I'm back at the desk" })
      yield* eventually(
        read(ReviewState.REVIEW_PREFIX + reviewID),
        (value) => ReviewState.review(value)?.status === "superseded",
      )
      yield* sessions.wait(session.id)
    }),
  )
})
