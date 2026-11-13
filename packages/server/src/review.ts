export * as ServerReview from "./review"

import { Instance } from "@opencode/core/instance/service"
import { KV } from "@opencode/core/kv"
import { storage } from "@opencode/core/plugin/host"
import { Session } from "@opencode/core/session"
import { ReviewBridge, ReviewHandler, ReviewNotify, ReviewState } from "@opencode/review"
import { Clock, DateTime, Effect, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

/**
 * Remote review approval page and submit, served next to the protocol API rather than in it, so the generated SDKs
 * stay untouched. The link's one-time token is the only credential: `ServerProcess` lets these paths through
 * without the server password.
 */
export const PATH = "/api/review/:id"
const PATTERN = /^\/api\/review\/[A-Za-z0-9_-]+$/

export function isReviewURL(url: URL) {
  return PATTERN.test(url.pathname)
}

const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
  "x-content-type-options": "nosniff",
}

const respond = (page: ReviewHandler.Response) =>
  HttpServerResponse.text(page.html, { status: page.status, contentType: "text/html; charset=utf-8", headers: HEADERS })

const millis = (value: DateTime.Utc | undefined) => (value === undefined ? undefined : DateTime.toEpochMillis(value))

/**
 * Also owns notifications: the plugin hands each new review to the publisher registered here, because only the
 * server knows its LAN and OpenTunnel URLs (`urls`).
 */
export const layer = (urls: () => ReadonlyArray<string>) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const sessions = yield* Session.Service
      const instances = yield* Instance.Service
      const context = yield* Effect.context<never>()
      const run = Effect.runForkWith(context)

      const find = (sessionID: string) =>
        sessions.get(Session.ID.make(sessionID)).pipe(Effect.option, Effect.map(Option.getOrUndefined))
      const handler = ReviewHandler.make({
        storage: storage(kv, ReviewState.PLUGIN_ID),
        now: Clock.currentTimeMillis,
        session: (sessionID) =>
          find(sessionID).pipe(
            Effect.map((info) => info && { busy: millis(info.time.busy), idle: millis(info.time.idle) }),
          ),
        diff: (sessionID) =>
          sessions
            .get(Session.ID.make(sessionID))
            .pipe(Effect.flatMap((info) => sessions.diff({ sessionID: info.id }).pipe(instances.provide(info)))),
        prompt: (input) =>
          sessions.get(Session.ID.make(input.sessionID)).pipe(
            Effect.flatMap((info) =>
              sessions
                .prompt({ sessionID: info.id, text: input.text, metadata: input.metadata })
                .pipe(instances.provide(info)),
            ),
            Effect.asVoid,
          ),
      })

      const notifier = ReviewNotify.make({
        env: process.env,
        urls,
        fetch: (url, init) => fetch(url, init),
        log: (message, details) => void run(Effect.logWarning(message, details ?? {})),
      })
      const unregister = ReviewBridge.register(notifier.push)
      yield* Effect.addFinalizer(() => Effect.sync(unregister))

      const params = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const route = yield* HttpRouter.RouteContext
        return { request, id: route.params.id ?? "" }
      })

      yield* router.add(
        "GET",
        PATH,
        Effect.gen(function* () {
          const { request, id } = yield* params
          const token = new URL(request.url, "http://localhost").searchParams.get("t")
          return respond(yield* handler.view(id, token))
        }),
      )
      yield* router.add(
        "POST",
        PATH,
        Effect.gen(function* () {
          const { request, id } = yield* params
          const body = new URLSearchParams(yield* request.text.pipe(Effect.orElseSucceed(() => "")))
          return respond(
            yield* handler.submit(id, { t: body.get("t"), decision: body.get("decision"), text: body.get("text") }),
          )
        }),
      )
    }),
  )
