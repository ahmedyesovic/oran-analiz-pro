# Native Mackolik team and fixture discovery

User-authorized local scope: retain the existing DuckDuckGo/Bing/Brave randomized
fallback and bot detection; additionally discover Mackolik matches through its
own team search and fixtures. Only verified Nesine odds are allowed.

## Verified provider surface

- Native autocomplete: `/ajax/search?keywords=...`; successful `results: []` is
  a valid empty result. Soccer contestants include a provider ID and team URL.
- Native fixtures: `/takim/{slug}/ma%C3%A7lar/{teamId}`. The encoded Turkish tab
  is necessary; `/maclar/` returned 404 in the live probe.
- The source page advertises season URLs in `seasonPickerData`; the verified
  previous-season navigation uses `?s=2025/2026`. Do not use guessed AJAX calls.
- Team identity is available in canonical URL, team information settings and
  fixture settings; displayed fixture rows supply stable match/team IDs, date
  and completed result markers. Fixtures never supply odds.

## Implementation contracts

1. Add strict pure parsers for native search and fixture pages, with reduced
   source fixtures. Validate identity, native links, calendar dates, completed
   scores, table structure and season URLs. Reject malformed data distinctly
   from valid empty results. Unknown/live/future states cannot become archives.
2. Add `MackolikNativeDiscovery.discover(home, away, date, {teamIdentities})`
   returning `{candidates, errors}`. Prefer known Mackolik team IDs; otherwise
   use shared exact/alias matching on native autocomplete. Never assume that
   Sahadan IDs are Mackolik IDs. Try the other team's schedule when needed.
3. Search the current season first; without a date, additionally try the latest
   preceding source-advertised season if no completed pair was found. With an
   explicit date, try at most two overlapping advertised seasons. Validate
   returned team and season identity. Sort completed pair candidates newest
   first and preserve the requested home/away order and squad qualifiers.
4. Insert native discovery after existing daily feeds and before existing web
   fallback. Keep stable-ID historical selections direct. Bound the new stage
   to 30 seconds, using at most half of the inherited remaining deadline so
   native discovery is also attempted after slow daily feeds. Keep source
   errors and immediately stop on Mackolik 429. Keep provider failures distinct
   from engine failures if neither path succeeds.
5. Pass candidates through the existing `/iddaa/` archive parser. Verify the
   native candidate's date, result and both team IDs against the archive before
   accepting it or remembering aliases. Ignore fixture odds and foreign-provider
   markets. Preserve verified completed matches with unavailable Nesine odds.

## Verification and release

Start from the existing 286 passing tests. Add red/green parser, orchestration,
lookup-order and Nesine-only integration regressions. Run the full suite, an
independent code review and a real local query. Preserve existing user AGENTS.md
changes and the ignored credential file. No commits, pushes, VDS changes or site
publication are authorized by this task.
