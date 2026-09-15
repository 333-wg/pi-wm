---
name: research
description: "Investigate external facts, official documentation, changing information and evidence-based comparisons. 调研、查资料、最新信息、来源核验。Not rewriting or summarizing supplied text unless fact-checking is requested."
---

# Evidence-based research

Define the decision/question, relevant date range and evidence needed. Separate
facts supplied by the user from claims requiring verification. Use the available
search/fetch tools; a referenced page must be read before it supports a claim.

Prefer official documentation for technical behavior, primary data for numbers
and original statements for attributed positions. Record retrieval date and
publication/event dates when relevant. Compare versions and applicability before
treating differences as contradictions.

For each load-bearing claim retain the source and supporting observation. Mark
inference explicitly. Do not present search snippets as full-page inspection or
an unsupported hypothesis as established fact. Read relevant counterevidence.

If retrieval fails, vary query specificity, use an official index or fetch a
known page through an available authorized method. Never invent citations or
claim a source was read when it was inaccessible. Explain unresolved questions
and the evidence needed to resolve them.

Choose a route from the request, not a fixed search-engine-first sequence:

- Read a supplied URL directly. For a named platform, prefer its own search page
  through browser_open; browser_search searches the configured general engine.
- Use general search for cross-site discovery. If queries keep returning the same
  irrelevant links, change the route or source instead of repeating near-synonyms.
- A loading shell or footer is not a negative finding. Use browser_snapshot with
  a bounded wait_for for expected content; stop and report limits if still blocked.
- Refs belong to a tab and snapshot version. After a stale-ref error, inspect
  browser_tabs, select the intended tab and use the fresh refs, never a blind retry.
- Distinguish candidate links, page text retrieved and claims actually checked.
  A video search page is not a watched video or a verified transcript. An empty
  tool result does not establish that matching information does not exist.

Do not bypass permission denials, access restrictions or network policy when
changing routes. Keep the number of attempts proportionate to the question.

Deliver conclusions with source attribution supported by the actual tools,
uncertainty and practical implications. Do not reproduce entire copyrighted
skills/articles as a shortcut; adapt the public workflow to available tools.
