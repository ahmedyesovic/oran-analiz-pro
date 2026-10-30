# Random free search fallback

Approved source: the in-chat plan, requested for local implementation on 2026-10-30.

## Requirements

Keep DuckDuckGo and add the free, no-key Bing and Brave HTML search pages. Shuffle
the three engines uniformly once per logical web lookup. Try each engine once,
in sequence, advancing after a block, malformed response, timeout or no matching
archive. Keep the Nesine/current/recent and Mackolik daily-feed paths ahead of
web discovery, and bypass all search engines for an explicitly selected match.

Maintain the existing API response shape, source selection, verified Nesine-only
odds, squad separation, exact historical identity/date/result validation, the
120-second request deadline and cancellation. No frontend changes are required.

## Tasks and interfaces

1. Add `searchProviders.js` with `SEARCH_PROVIDERS`, `buildSearchUrl`,
   `shuffledSearchProviders`, `parseSearchPage`, `SearchPageError`, and
   `normalizeSearchResultUrl`. Keep `{url, title}` candidates, safely unwrap
   engine redirects and accept only canonicalizable Mackolik match URLs. Add
   compact HTML fixtures and parser/shuffle regressions.
2. Extend transport allowlisting to Bing/Brave; coordinate both DuckDuckGo
   aliases together. Persist five-minute bot cooldowns and preserve authoritative
   `Retry-After` deadlines. Add `markSearchBlocked(url, {status})` and
   `runSourceTask(..., {maxAttempts: 1})`, retaining two attempts by default for
   other callers. Distinguish bot responses from explicit HTTP 429.
3. Integrate request-local shuffled discovery in `MackolikScraper`. Remove the
   DuckDuckGo-only curl chain and browser search restart. Browser fallback opens
   collected archive candidates only. Retain a global web budget of eight HTTP
   archive candidates and five browser archive candidates. A Mackolik archive
   429 stops discovery; changing search engines cannot bypass that cooldown.
4. Run regressions, inspect the full change independently and perform a real
   local query. Report live provider limitations separately from deterministic
   test results. Leave the working local app available for user review.

## Failure semantics

Only recognized result pages or explicit empty-result markup establish empty
searches. Challenges and unrecognized responses are errors, even with HTTP 200.
Try other engines before returning an error. A verified match overrides earlier
discovery failures; absent one, retain provider/parse failures rather than
reporting a normal missing match. Never create odds from a search snippet.

## Release constraint

Changes and tests stay local. Do not commit/push, create a PR, transfer files to
the VDS, restart its service or publish either frontend without a new explicit
user instruction.
