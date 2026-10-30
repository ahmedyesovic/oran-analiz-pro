# Local native Mackolik verification — 2026-10-30

Verified at approximately 21:21 Europe/Istanbul on Node.js v26.13.0. Changes stay
local and uncommitted; existing AGENTS.md edits and the ignored credential file
were preserved. No VDS, GitHub or frontend publication was performed.

## Behavior

The original current Nesine → recent results → Mackolik daily-feed order remains.
When unresolved, Mackolik now uses its own team autocomplete and native fixtures
before the existing randomized DuckDuckGo/Bing/Brave fallback. Search-engine bot
recognition, per-engine cooldowns and source coordination remain in place.

Native fixture pages supply discovery metadata only. The ordinary `/iddaa/`
archive must confirm match ID, both team IDs, date and completed score. Only the
existing verified Nesine provider parser supplies odds. Foreign-provider odds
are excluded, including when no Nesine odds are available; verified completed
results without a Nesine archive retain `ODDS_NOT_FOUND`.

Known Mackolik team IDs skip autocomplete. Other source IDs are not reused.
Native discovery preserves squad qualifiers and home/away order, uses advertised
season links and is bounded to the current/previous season or at most two
overlapping date-specific seasons. Its 30-second budget reserves fallback time
within the original request deadline. Selected historical ID/date queries still
open the archive directly.

## Automated checks

- Baseline: 286 tests passed before native implementation.
- Final `npm run test:historical`: **339 passed, 0 failed**, 3.15 seconds.
- Red/green coverage: native parser (13 cases), native network discovery (25),
  end-to-end lookup integration (14), and encoded Unicode match URLs (1).
- Parser examples were reduced from real Mackolik team search, empty search,
  current-season fixtures and previous-season fixtures. Full source captures
  also parsed successfully: 19 and 57 completed fixture rows respectively.
- Tests cover aliases, women/reserve/youth separation, source-specific IDs,
  renamed identity evidence, both-side schedule discovery, season limits,
  completed states, invalid tables/links, calendar dates, archive ID/date/score
  conflicts, retained errors, cancellation/deadlines and immediate 429 stopping.
- Integration tests explicitly verify Nesine-only odds and foreign-only archive
  rejection, as well as preserving the existing web fallback and direct-ID path.
- One initial concurrent full-suite run hit the existing 30-ms H2H transport
  timer assertion (337/338). That file passed alone, the next complete run
  passed 338/338, and the final run after the date-format correction passed
  339/339. No H2H implementation or timing tests were changed.
- Independent code review found no Important or Critical defects. Its minor
  date-format consistency finding was reproduced with a failing test and fixed
  by passing the existing canonical date into native discovery.
- JavaScript syntax and owned-file whitespace checks passed.

## Real local verification

Native diagnostics deliberately skipped daily feeds to isolate the added stage;
web engine calls were instrumented and remained **zero** in both examples.

| Exact input | Native result | Verified odds |
| --- | --- | --- |
| `Real Madrid` / `Sevillia` | 18.10.2026, 4–1, ID `7rd18hnvlmxll7j7gck3xm9ec` | 50 Nesine markets |
| `Valencia` / `Athletico Bilbao` | 17.10.2026, 0–0, ID `7rok8grdb96ofrabvw5pkyxhw` | 51 Nesine markets |

Madrid required native autocomplete, team fixtures and the archive: three
Mackolik requests. Valencia resolved through the away team's native fixture
page after team discovery, demonstrating the other-side path.

After restarting the final local app, the normal `/api/fetch-match` request with
the exact `Real Madrid` / `Sevillia` input also returned HTTP 200 in 7.87 seconds,
the correct 18.10.2026 match and 50 verified Nesine markets. This final request
used the normal current/recent/daily/native lookup flow.

The app remains bound to `127.0.0.1:3000` for user review. Provider availability
is established only for these probes; future 429/502 responses remain possible.
Frontend code and export design were unchanged; no new mobile/theme/browser or
PNG checks were performed for this backend change.

## Follow-up: reported search cooldown errors — 21:32 Europe/Istanbul

The user reported DuckDuckGo 287-second and search HTTP-429 21-second errors.
Those exact messages were present in the local server log; they were not
assumed to come only from the still-unchanged deployed sites. The reported
team inputs had not yet been supplied, so the exact failing pair remains
unverified.

Two local defects were independently reproduced and corrected:

- A fixed 30-second fallback reserve skipped native discovery entirely when
  no more than 30 seconds remained. Native now receives up to 30 seconds and
  at most half of the remaining deadline, preserving fallback time without
  skipping the native stage solely because less than 30 seconds remain.
- The final error preferred any `retryAfter`, letting an engine cooldown hide
  a native/provider failure. Engine errors are now kept separately. When both
  paths fail, the provider error retains its status, upstream status, cause
  and retry policy; the engine failure is included as additional context.

The initial three targeted checks failed before the fix and passed afterward.
Additional coverage confirms fallback after native timeout, no archive request
from a late native candidate, and unchanged authoritative browser archive 429.
The final full `npm run test:historical` run passed **343/343**, with no failures
or cancellations. Syntax/whitespace checks passed. Independent review found no
Critical/Important defect; its two coverage suggestions were added and passed.

Live native-only diagnostics additionally resolved Manchester City–Ipswich
Town (49 Nesine markets) and Bayer Leverkusen–Freiburg (51), each with zero web
engine requests and three Mackolik requests. These were sequential probes.

The new local server then handled ordinary API requests:

- `Roma` / `Genoa`: HTTP 502 in 9.12 seconds. Native autocomplete returned
  HTTP 500 for both names; fallback still encountered a DuckDuckGo challenge.
  The API retained `PROVIDER_UNAVAILABLE` and showed both failures instead of
  attributing the whole lookup to a search-only cooldown. **This match's
  provider access is not fixed.**
- `Manchester City` / `Ipswich Town`: HTTP 200 in 11.53 seconds, correct
  17.10.2026 completed match, 49 Nesine markets, no warnings.

Ordinary native autocomplete variants `AS Roma`, `roma`, `Rom` and `Geno` also
returned HTTP 500; `Genoa CFC` returned HTTP 502. A Manchester City control
returned HTTP 200 with the same request headers. The normal source JavaScript
uses a trimmed, URL-encoded keyword of at least three characters; no missing
required parameter was found. These source HTML error pages did not show a
CAPTCHA marker. The provider's internal cause remains unknown.

The local app remains on `127.0.0.1:3000`, with loopback-only local source
diagnostics enabled for reproduction. No production publication, credentials
change, frontend change or H2H behavior change was performed.

## Exact reported Chelsea / Manchester United — 21:43 Europe/Istanbul

The user's screenshot identified the exact input `Chelsea` / `Manchester United`
with Mackolik selected. Local source traces showed Chelsea autocomplete HTTP
500, but Manchester United autocomplete HTTP 200. The latter returned main-team
`Man. United` alongside separate U19/II teams. The shared matcher rejected that
main-team abbreviation, preventing the away-team fixture fallback.

Both shared normalizers now explicitly recognize `Manchester United`,
`Man. United`, `Man Utd` and `Manchester Utd`. Women, reserves, U19/II, other
United clubs and Manchester City remain separate. Existing compact-name and
`MU` behavior is preserved. This also fixes current bulletin recognition of
Nesine's `Man. Utd` name, which had caused unnecessary archive discovery.

After that correction, the real United fixture page revealed another failure:
one of 102 source-advertised seasons is `2008 Japan`. The old numeric-only
validation rejected the whole page. The parser now accepts a year or year pair
with up to two short alphabetic label words, retaining strict origin, team ID,
selected season and exact season-query checks. Discovery uses only the leading
years for selection; it navigates the original advertised URL. A reduced real
United fixture preserves the named season, a completed Hull–United row and the
future Chelsea–United row, which remains excluded from completed results.

Verification:

- Five alias/discovery/archive regressions failed before the alias fix and
  passed afterward. The real named-season fixture failed before the parser
  correction; named-season validity, hostile/conflicting links and exact-label
  navigation are also covered. Current Nesine lookup has an exact-input
  regression with women/youth/City decoys.
- Final `npm run test:historical`: **353 passed, 0 failed**, 3.27 seconds.
  JavaScript syntax and owned-file whitespace checks passed. Independent review
  found no Critical/Important defect in the alias and season changes.
- Native-only exact-input diagnostic: five Mackolik requests, **zero search
  engine requests**, correct completed archive `4m0hv0y707imwzwo2dileo2s4`,
  18.04.2026, Chelsea 0–1 Man. United, **52 verified Nesine markets**. Chelsea
  autocomplete still returned HTTP 500; the verified away-team route recovered.
- After restarting the final local server, ordinary `/api/fetch-match` returned
  HTTP 200 in 1.21 seconds, **56 current Nesine markets** for Chelsea–Man. Utd,
  31.10.2026, code 3253549. The bulletin remains ahead of archive discovery.
- Ordinary `/api/historical-odds` returned HTTP 200 in 8.77 seconds, the same
  verified 18.04.2026 archive and **52 Nesine markets**, without warnings.
- Independent Sahadan `/api/head-to-head` returned HTTP 200 in 4.68 seconds,
  **10 initial-table rows**, using the nearest future 31.10.2026 source match.
- A real headless Chrome form submission at 1440px confirmed both HTTP-200
  responses, 56 current markets, 10 displayed history rows and no page errors.
  Its screenshot `/private/tmp/oran-chelsea-final-ui.png` was inspected.
  Puppeteer's bundled Chrome was unavailable, so the check used the installed
  Chrome executable without installing or changing dependencies. Safari,
  mobile/theme interactions and PNG exports were not rechecked.

The local app remains at `http://localhost:3000`. No server transfer, GitHub
push/PR/merge or live publication was performed. These exact-input successes do
not establish availability for unrelated matches or future provider requests.

## Follow-up Chelsea / united — 21:53 Europe/Istanbul

The next screenshot changed the away field to literal lowercase `united`.
That shared word intentionally does not identify Manchester United. Previously
the unresolved input continued into provider discovery, producing unrelated
HTTP 500/429 and independent H2H 502 errors.

Both shared normalizers now expose the same generic-name check, using their
existing ambiguous-token set. The common `MatchService.resolveTeams` stops
unselected generic pair/H2H input with an explanatory 400 `INVALID_QUERY`,
requesting a full name or explicit team selection. This does not add a global
United→Manchester United alias. Selected IDs retain ID/name/squad validation.
Historical match ID/date selections and genuinely used current bulletin codes
retain direct verification; unused codes in historical/date-specific queries
and H2H cannot bypass the guard.

- Five initial checks failed before implementation. Independent review exposed
  two boundary cases: stable archive selections and unused codes. Both were
  reproduced with failing regressions and corrected. Final targeted: 12/12;
  final `npm run test:historical`: **365/365**, no failures, 3.05 seconds.
- After restarting the final local server, ordinary odds and H2H requests with
  exact `Chelsea` / `united` returned explanatory HTTP 400 in 12ms and 6ms.
  Neither response imposed `Retry-After`. All three local provider trace lists
  remained empty: no Nesine, Mackolik or Sahadan calls were made by those queries.
- A real Chrome form submission displayed the new message. Replacing the away
  field with `Man. Utd` then returned HTTP 200 for both routes, **56 Nesine
  markets**, **10 displayed Sahadan rows**, and no page errors.
- The first browser automation attempt failed to clear the original input and
  submitted `uniteMan. Utd`; source traces identified that diagnostic mistake.
  The helper now selects the whole input explicitly and asserts its final
  value before submitting. The corrected browser verification passed.
- The clarification screenshot `/private/tmp/oran-united-clarification-ui.png`
  was inspected. Frontend source/layout, Safari/mobile/theme interaction and
  PNG exports were not changed or reverified.

The app remains local at `http://localhost:3000`; no deployment or GitHub
publication was performed. Existing unrelated AGENTS.md edits were preserved.
