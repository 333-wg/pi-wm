# Search reliability changes (2026-09-15)

## Scope

Keep the configured search providers and selected model. No new API key, model
routing layer, or paid search service is introduced. The unused Readability/jsdom
preparation was removed from the sandbox's direct dependencies.

- Research guidance no longer requires a general-engine search first. Read a
  supplied URL directly; use a named platform's own search when appropriate.
  Repeated irrelevant results should trigger a route change, not endless synonyms.
- Browser searches run in a temporary tab, preserve the active page and its refs,
  and close the temporary tab on success, failure, or cancellation. Result headings
  take precedence over breadcrumb links.
- Refs include tab and snapshot identity. A newer snapshot or navigation invalidates
  old refs; a wrong-tab or detached ref fails without replaying a click.
- Sparse pages receive a bounded content wait (default 2 seconds). A CSS
  wait_for selector defaults to 5 seconds, with a 10-second ceiling and the browser
  default timeout as an additional cap. Explicit timeout returns the current
  snapshot with insufficient evidence; it is not proof that content does not exist.
- Tool metadata, live progress, and saved transcript items carry optional evidence
  state. Old records without it remain valid. The UI distinguishes execution status
  from candidate links, retrieved page text, insufficient content, or access errors.

## Evidence limits

Classification is a conservative heuristic based on HTTP status and available
text after excluding common navigation/footer markup. It does not verify semantic
relevance, source reliability, publication dates, video playback, or transcripts.
Custom login walls, CAPTCHAs, and unusual page markup can still require inspection.
Permission denials and network policy must not be bypassed when changing routes.

## Automated checks

- Sandbox tests: temporary-tab isolation, title extraction, stale/wrong-tab refs,
  dynamic content, selector timeout, footer-only pages, HTTP errors, cancellation,
  popup activation, tool parameter forwarding, and existing downloads.
- Pi adapter tests: validated evidence in progress and transcript results;
  reject invalid metadata, unrelated tools, and failed tool results.
- Web tests: evidence labels are separate from successful execution; legacy,
  running, and error tool traces retain their behavior.
- Playwright: the real ToolCard component and app styles, with deterministic
  evidence fixtures at 1440px and 390px, expansion and no-overlap checks. This is
  component integration coverage, not a live external search or model benchmark.
- Production build, workspace test type checks, and E2E type checks.

Run from the repository root:

    npm run build
    npm run check:tests
    npm run check:e2e
    npm run test --workspace @wuming/sandbox
    npm run test --workspace @wuming/pi-adapter
    npm run test --workspace @wuming/protocol
    npm run test --workspace @wuming/web
    npx playwright test e2e/search-evidence.spec.ts

## Manual model comparison (not executed)

Use the same model settings, tool configuration, permission policy and fresh
sessions for each comparison. Repeat each case at least three times. Record
time to the first useful source, total calls, repeated failed calls, opened source
URLs and whether the final claims are supported. Do not score answer fluency as
search success.

1. Supplied article URL: open directly and summarize only retrieved material.
2. YouTube Pi tutorials: find actual videos and distinguish metadata from watching.
3. A named repository issue: use the repository and its issue search appropriately.
4. A broad cross-site topic: use general search and open relevant candidates.
5. Ambiguous project name: establish the intended entity before collecting sources.
6. A recent release: check the official source and the exact publication date.
7. Repeated irrelevant engine results: change route without a synonym loop.
8. Loading shell/footer: bounded reread; report limits if still empty.
9. Page interaction followed by search: preserve the active page and valid refs.
10. Login/access restriction: report the boundary without inventing missing facts.

Restart the gateway to load the backend changes. The current browser sessions and
models were not forcibly restarted or changed by this patch. New results carry
evidence metadata; old saved results are not retroactively reclassified.
