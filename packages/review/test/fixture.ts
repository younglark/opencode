import { Effect, Schema } from "effect"
import type { ReviewController } from "../src/controller.js"

export function memoryStorage(): ReviewController.Storage & { readonly map: Map<string, Schema.Json> } {
  const map = new Map<string, Schema.Json>()
  return {
    map,
    get: (key) => Effect.sync(() => map.get(key)),
    set: (key, value) => Effect.sync(() => void map.set(key, structuredClone(value))),
    remove: (key) => Effect.sync(() => void map.delete(key)),
    scan: (options) =>
      Effect.sync(() => {
        const keys = [...map.keys()]
          .filter((key) => key.startsWith(options.prefix) && (options.after === undefined || key > options.after))
          .sort()
        const limit = options.limit ?? 100
        const entries = keys.slice(0, limit).map((key) => ({ key, value: map.get(key)! }))
        return keys.length > limit ? { entries, next: entries.at(-1)!.key } : { entries }
      }),
  }
}

export const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
