export * as ReviewRpc from "./rpc.js"

import { Rpc } from "@opencode/schema/rpc"
import { Schema } from "effect"

export const Hint = Schema.Struct({
  level: Schema.Literals(["warning", "info"]),
  message: Schema.String,
})

export const Status = Schema.Struct({
  enabled: Schema.Boolean,
  durationMs: Schema.Number,
  /** False when no server layer reported its URLs; lan/public are then unknown, not missing. */
  addressesKnown: Schema.Boolean,
  lan: Schema.NullOr(Schema.String),
  public: Schema.NullOr(Schema.String),
  /** Webhook env vars the server process has set. */
  channels: Schema.Array(Schema.String),
  /** Open review links that have not expired, across every project. */
  pending: Schema.Number,
  /** Epoch millis when the asked-for session's idle timer fires. */
  timerAt: Schema.NullOr(Schema.Number),
  /** Epoch millis when the asked-for session's open review link expires. */
  reviewUntil: Schema.NullOr(Schema.Number),
  /** Setup the user still has to do; the plugin never changes service config. */
  hints: Schema.Array(Hint),
}).annotate({ identifier: "Review.Status" })
export type Status = typeof Status.Type

export const Result = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  status: Status,
}).annotate({ identifier: "Review.Result" })
export type Result = typeof Result.Type

/**
 * The remote review plugin's RPC, for the TUI. `status` reads settings and setup gaps; `run` takes the same text as
 * `/review-remote` and never fails for a user error, so the client can show the message. Every settings change
 * publishes `changed`.
 */
export const Definition = Rpc.define({
  id: "opencode.review",
  methods: {
    status: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.optionalKey(Schema.String) })),
      output: Schema.toStandardSchemaV1(Status),
    },
    run: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, text: Schema.String })),
      output: Schema.toStandardSchemaV1(Result),
    },
  },
  events: {
    changed: {
      schema: Schema.toStandardSchemaV1(Schema.Struct({ enabled: Schema.Boolean, durationMs: Schema.Number })),
    },
  },
})
