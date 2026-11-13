# review-annotator

Isolated image annotator used by `@opencode/review`. It is a modified copy of the
[EditHere](https://github.com/Inginnng/EditHere) web app (v0.13.0) and stays under the
**PolyForm Noncommercial License 1.0.0**. It is not MIT-licensed, unlike the rest of this fork.

See `LICENSE`, `NOTICE`, and `UPSTREAM.md`. The shipped UI does not use the EditHere name or logo;
license attribution is kept. Commercial use (including in a commercial game project) still needs a
separate license from the author.

Build: `node build.mjs` writes `annotator.html`. The approval page serves that file at
`/api/review/:id/annotator?t=` and talks to it with `postMessage`.
