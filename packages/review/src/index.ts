import { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { DateTime, Effect, FiberMap, Stream } from "effect"
import { ReviewBridge } from "./bridge.js"
import { ReviewCommand } from "./command.js"
import { ReviewController } from "./controller.js"
import { ReviewInbox } from "./inbox.js"
import { ReviewState } from "./state.js"
import { ReviewSummary } from "./summary.js"

export { ReviewBridge } from "./bridge.js"
export { ReviewCommand } from "./command.js"
export { ReviewController } from "./controller.js"
export { ReviewDecide } from "./decide.js"
export { ReviewDuration } from "./duration.js"
export { ReviewFeedback } from "./feedback.js"
export { ReviewHandler } from "./handler.js"
export { ReviewInbox } from "./inbox.js"
export { ReviewNotify } from "./notify.js"
export { ReviewPage } from "./page.js"
export { ReviewState } from "./state.js"
export { ReviewToken } from "./token.js"

const millis = (value: DateTime.Utc | undefined) => (value === undefined ? undefined : DateTime.toEpochMillis(value))

export default Plugin.define({
  id: ReviewState.PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const timers = yield* FiberMap.make<string>()

      const session = (sessionID: string) =>
        ctx.session.get({ sessionID: Session.ID.make(sessionID) }).pipe(
          Effect.map(
            (info): ReviewController.SessionView => ({
              id: info.id,
              parentID: info.parentID,
              title: info.title,
              directory: info.location.directory,
              busy: millis(info.time.busy),
              idle: millis(info.time.idle),
            }),
          ),
          Effect.catchCause(() => Effect.succeed(undefined)),
        )

      // Summaries cost tokens in the session they describe; on any failure the last assistant text stands in.
      const summarize = (sessionID: string) =>
        ctx.session.generate({ sessionID: Session.ID.make(sessionID), prompt: ReviewSummary.PROMPT }).pipe(
          Effect.map((result) => ReviewSummary.clip(result.text)),
          Effect.timeout("90 seconds"),
          Effect.catchCause((cause) =>
            Effect.logWarning("review summary failed; using the last reply", { sessionID, cause }).pipe(
              Effect.andThen(ctx.session.context({ sessionID: Session.ID.make(sessionID) })),
              Effect.map((messages) => ReviewSummary.fallback(messages)),
              Effect.catchCause(() => Effect.succeed("")),
            ),
          ),
        )

      const controller = ReviewController.make({
        directory: ctx.location.directory,
        storage: ctx.storage,
        now: Effect.clockWith((clock) => clock.currentTimeMillis),
        session,
        summarize,
        publish: (review) => Effect.sync(() => ReviewBridge.publish(review)),
        schedule: (sessionID, delayMs, effect) =>
          FiberMap.run(timers, sessionID, Effect.sleep(delayMs).pipe(Effect.andThen(effect))).pipe(Effect.asVoid),
        cancel: (sessionID) => FiberMap.remove(timers, sessionID),
      })

      const warn = (message: string, sessionID: string) =>
        Effect.catchCause((cause: unknown) => Effect.logWarning(message, { sessionID, cause }))

      yield* ctx.event
        .subscribe({
          types: [
            "session.execution.started",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
            "session.inbox.enqueued",
            "session.deleted",
          ],
        })
        .pipe(
          Stream.runForEach((event) => {
            const sessionID = event.data.sessionID
            switch (event.type) {
              case "session.execution.started":
                return controller.started(sessionID).pipe(warn("review: failed to clear a timer", sessionID))
              case "session.execution.interrupted":
                // Shutdown keeps the stored deadline; the next process restores it. A superseded execution is
                // replaced by a new one that reports its own end.
                if (event.data.reason === "shutdown" || event.data.reason === "superseded") return Effect.void
                return controller.finished(sessionID).pipe(warn("review: failed to arm a timer", sessionID))
              case "session.execution.succeeded":
              case "session.execution.failed":
                return controller.finished(sessionID).pipe(warn("review: failed to arm a timer", sessionID))
              case "session.inbox.enqueued":
                if (!ReviewInbox.isHumanInput(event.data.item)) return Effect.void
                return controller.humanInput(sessionID).pipe(warn("review: failed to cancel on input", sessionID))
              case "session.deleted":
                return controller.removed(sessionID).pipe(warn("review: failed to drop a deleted session", sessionID))
            }
          }),
          Effect.catchCause((cause) => Effect.logWarning("review event stream stopped", { cause })),
          Effect.forkScoped({ startImmediately: true }),
        )

      // An idle project's Location unloads after a while and takes its timers with it; deadlines stay in storage.
      yield* controller
        .restore()
        .pipe(
          Effect.catchCause((cause) => Effect.logWarning("review: failed to restore timers", { cause })),
          Effect.forkScoped({ startImmediately: true }),
        )

      yield* ctx.command.transform((editor) => {
        editor.add({
          name: ReviewCommand.NAME,
          description: "send a phone review link after the session sits idle [<duration>|on|off|now]",
          execute: (input) =>
            Effect.gen(function* () {
              const text = input.prompt.text
              const result = yield* controller.command(input.sessionID, text)
              // Like /goal, status text reaches the user through the command's failure message.
              if (ReviewCommand.parse(text).type === "status") return yield* Effect.fail(new Error(result))
              yield* Effect.logInfo(result, { sessionID: input.sessionID })
            }),
        })
      })
    }),
})
