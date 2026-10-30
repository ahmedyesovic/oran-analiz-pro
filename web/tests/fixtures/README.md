# Sahadan H2H fixtures

Captured on 2026-09-05 from these public comparison pages:

- Genoa–Como: https://www.sahadan.com/mac/genoa-vs-como/71gd82o5fcewilgjp27s3mhp0/karsilastirma
- Arsenal–Chelsea: https://www.sahadan.com/mac/arsenal-vs-chelsea/41cldzbwls4xo9gxeu50cu2vo/karsilastirma

The H2H table and similarly titled statistics cards retain their source HTML.
Unrelated page sections were removed; one synthetic form-results section was
added to test isolation. Nuxt data was reduced to the original source match and
its H2H records, then encoded as the same reference-table format. Those hidden
records must never supply the displayed rows. No “Tümünü Göster” action was taken.

## HTML search fixtures

`search-bing-results.html` and `search-brave-results.html` contain one reduced
organic result from public HTML search responses captured on 2026-10-30 for
Real Madrid–Sevilla Mackolik discovery. Bing's response returned an unrelated
Transfermarkt result; this deliberately verifies that recognizable results
without a valid Mackolik match are distinct from malformed HTML. Brave's
response contains the actual Mackolik match title and date. Result containers,
title links and text retain their source structure; scripts, styles, images,
event handlers and tracking parameters were removed. Bing's `u=a1...` redirect
target remains encoded as served, without its unrelated tracking parameters.

`search-duckduckgo-results.html` uses a minimal representative DuckDuckGo HTML
organic-result structure with deterministic Lavallois–Red Star data. It checks
the `uddg` redirect and a duplicate display URL; it is not a captured live page.

## Native Mackolik team discovery fixtures

Captured on 2026-10-30 from Mackolik's public native team search and Real Madrid
fixtures pages. `mackolik-native-search.json` retains the actual football team
contestants (main team, U19 and II) and player result. `mackolik-native-empty.json`
retains the provider's explicit successful empty-result shape.

`mackolik-native-fixtures.html` retains the original canonical link, team
information module, matches settings and selected real rows from the current
2026/2027 fixtures page. It includes wins, a loss, a draw, an upcoming match and
league/header rows. `mackolik-native-season-2025.html` retains the 2025/2026 page
and its Real Madrid–Bayern Münih row with the provider's encoded Unicode match
URL. Both pages preserve the first three season options and corresponding
season-picker settings. Unrelated scripts, cookies and page sections were
removed; retained source rows, calendar dates, scores and identity attributes
were not rewritten. These fixtures provide discovery metadata, never odds.

`mackolik-native-man-united.html` reduces the Manchester United fixtures page
captured on 2026-10-30. It preserves the canonical and module identities, the
2026/2027 and 2025/2026 options, and the real named tournament season `2008 Japan`
with its original season-picker URL. The original Hull City 2–0 Man. United row
(2026-08-22) and upcoming Chelsea–Man. United row (2026-10-31) remain unchanged.
This fixture verifies that a valid named historical season does not invalidate
the current fixture page, while the upcoming match still supplies no score.
