# Local verification — random free search — 2026-10-30

Completed at 20:51 Europe/Istanbul. All changes remain local and uncommitted.
The existing user modifications in `AGENTS.md` were preserved, not edited.

## Implemented behavior

- DuckDuckGo, Bing and Brave use free HTML search with no API credentials.
- Each logical web lookup uniformly shuffles the engines once and advances
  after failure or no matching candidate; each engine receives one query.
- Bot cooldowns last five minutes; explicit HTTP 429 honors `Retry-After` and
  longer existing limits. DuckDuckGo aliases share cooldowns and request slots.
- Browser fallback opens collected Mackolik match URLs only. The old curl and
  browser DuckDuckGo search restarts were removed.
- Current/recent/daily-feed order, direct historical selection, source identity,
  squad checks, completed results and verified Nesine odds remain authoritative.

## Deterministic verification

- Baseline: 242 tests passed on Node.js v26.13.0.
- New parser and transport tests were observed failing before implementation.
  The initial 13 integration regressions also failed before implementation.
- Final `npm run test:historical`: **286 passed, 0 failed**, 2.79 seconds.
- Coverage includes shuffle permutations, per-request ordering, all three
  parsers, trusted redirect decoding, empty vs malformed/challenge responses,
  persisted cooldown expiry/reopening, DuckDuckGo aliases, engine failover,
  archive rate limits, the inherited deadline and global candidate budgets.
- Independent review found duplicate match tabs consuming raw result slots.
  A new failing regression reproduced this; the fix counts distinct archive
  attempts. Reviewer's independent captured-HTML reproduction subsequently
  resolved the previously omitted target within the eight-request limit.
- Independent final review: no outstanding Critical or Important findings.
- Changed JavaScript syntax checks and owned-file `git diff --check` passed.

## Real local queries

1. `GET /api/fetch-match?home=Real+Madrid&away=Sevilla&source=mackolik`
   returned HTTP 200 in 14.68 seconds: match `7rd18hnvlmxll7j7gck3xm9ec`,
   2026-10-18, score 4–1, **50 verified Nesine markets**.
2. The direct web-discovery diagnostic, with DuckDuckGo selected first for
   reproducibility, found five candidates and the same verified match/50 markets.
3. A second diagnostic starting with Bing exercised an actual unavailable path:
   Bing returned a recognized page with zero usable match links, Brave returned
   HTTP 429, and DuckDuckGo returned HTTP 202. All three were tried once; the
   result remained HTTP 503 rather than a fabricated missing-match success.
4. After the final candidate-budget correction and local app restart, direct
   historical selection by the same stable ID/date returned HTTP 200 in 2.41
   seconds with the same score and 50 verified Nesine markets. This preserves
   the selected-match path without querying a search engine.
5. The final local health endpoint returned `{"status":"ok"}`. The app was
   left listening only on `127.0.0.1:3000` for local review.

## Limits and release state

The free engines can all be blocked or return no usable match links at once,
as the second real diagnostic demonstrated. The new fallback is implemented;
uninterrupted provider access is not established. The genuine 202→Bing recovery
path is covered with deterministic provider responses; this session did not
obtain a successful live Brave/Bing match resolution through Node fetch.

Frontend code, themes, PNG exports and layouts were unchanged; no new UI,
lint/build or browser-layout verification was performed for this backend change.
No application files were uploaded to the VDS, no production service was
restarted, and no commit, push, PR, Netlify or GitHub Pages publication occurred.
