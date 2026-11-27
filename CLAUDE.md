# Stroomviewer WMS — project guide for Claude

Follow the Cegeka app blueprint (house style, tokens, components, connection patterns). Dependency-free Node server
bound to 127.0.0.1, plain HTML/CSS/JS with classic scripts, one `state` object, `render*()` functions. No frameworks,
bundlers or new dependencies unless the user asks.

## Rules (from the instructions document)
- Start every phase with a short plan and wait for approval. Show a visual proposal before building new screens.
- When D365 F&O behaviour is unclear: ask. Never invent field names or logic. An assumption becomes a TODO in the code
  and a row in `docs/assumptions.md`.
- Customer data (`/data`) and the customer mapping never go into git or test fixtures.
- Every pipeline step has unit tests on the fictional dataset, including a directive without ranges and a location
  without a zone.
- Unsolvable cases are shown in the UI, never filtered away silently.
- Only GET towards D365 (app/lib/readonly-http.js + tests/readonly-http.test.js). Secrets never reach the browser or logs.

## Conventions
- Code, comments, commit messages and docs in English; UI text and conversation in Dutch.
- Escape every value with `escapeHtml()` before it goes into innerHTML. Errors go in `.message.error` next to the action.
- Colours only from the tokens in app/styles.css; flow colours always come with a line style and the legend.
- After frontend edits: `npm run check`, `npm test`, and curl the API against the running server.
- Keep `docs/changelog.md` (newest on top). When docs and code disagree, trust the code.
