# Repository Guidelines

## Project Structure & Module Organization

- `web/server.js` provides the Express API and serves the frontend.
- `web/src/` contains match lookup, historical resolution, scraping, parsing, and categorization.
- `web/tests/` contains deterministic historical-resolution, Sahadan H2H, request-lifecycle, and theme tests; source HTML samples live in `web/tests/fixtures/`.
- `web/frontend/` is the React/Vite UI; `web/public/` is the legacy UI.
- `web/frontend/src/utils/matchRequests.js` coordinates independent odds and H2H requests; `web/frontend/src/utils/theme.js` and `web/frontend/src/components/ThemeSelector.jsx` manage frontend themes.
- Keep team-name behavior aligned between `utils/normalize.js` and `extension/utils/normalize.js`.
- `extension/` is the Manifest V3 Chrome extension; runtime code is under `background/`, `content/`, `popup/`, and `utils/`.

## Architecture Notes

Default lookup checks the current Nesine bulletin, recent results, then Mackolik. Historical events preserve `HTTR`/`ATTR` aliases. Without a Nesine date, `MackolikScraper` scans seven daily feeds before web-search fallback. Preserve this order, accept only verified Nesine odds, and add aliases through the shared matcher rather than one-off replacements.

- A selected historical row supplies `matchId`, teams, and date. Open that match directly and verify its identity, teams, date, and completed result instead of rediscovering it through search. Preserve this behavior for both Mackolik and Sahadan.
- A verified old match may have no odds archive. For Sahadan, a missing Iddaa code or an odds-endpoint HTTP 404 means unavailable odds, while retaining the verified match result. Do not turn missing match details, malformed responses, timeouts, or other provider failures into a successful empty result.

### Sahadan Head-to-Head Data

- `/api/head-to-head?home&away` always uses Sahadan, independently of the selected historical odds source. `SahadanScraper` and `sahadanParser.js` scrape the initially rendered **Aralarındaki Maçlar** HTML table from `/mac/{slug}/{id}/karsilastirma`.
- Team schedules and Nuxt data discover and verify the source match; they must not supply or expand the displayed rows. Do not merge hidden history, activate **Tümünü Göster**, impose a ten-row cap, or restore the removed hardcoded old-match exclusions.
- Choose a matching live (`Playing`) source match first, otherwise the nearest future `Fixture`, otherwise the latest completed `Played` match. Accept either team order through the shared matcher without confusing youth, reserve, or women's teams.
- Preserve source row order, teams, full-time and half-time scores, and calendar dates. Convert displayed `DD.MM.YYYY` dates to ISO dates without timezone shifts or invented kickoff times. Validate row links and reject malformed tables rather than silently dropping rows.
- Return actual `count`, per-row `halfTimeScore`, and `sourceUrl`, `sourceMatchId`, `sourceMatchDate` provenance. Keep a valid empty table distinct from missing comparison pages and parsing/transport failures.

## Frontend Behavior

- The search form has no optional date input. Historical row selection still sends its date and stable match ID.
- Keep **Oranları Bul** and **Temizle** together with equal width and 50 px height; the group may wrap below the fields, but the buttons stay side by side on mobile.
- **Temizle** clears team fields, odds, H2H, errors, loading states, and selection; aborts both request types; and ignores late replies. Preserve the chosen odds source and theme, return focus to the home-team field, and allow a new search afterward.
- The H2H panel sits on the right at desktop widths of at least 1100 px and below the main content on smaller screens. Keep readable match rows with the date above team names, aligned full-time/half-time score columns, full-row buttons, and a visible selected state.
- Selecting a historical row updates only the odds request and selected indicator. Preserve the original H2H data, source page, and scroll position. A new team-pair search must clear the previous pair's table and ignore stale responses.
- In `MatchResult`, hide **KORNER & KART** and its markets only when `isHistorical === true`. Use the filtered categories for rendering and PNG exports; historical clipboard formatting must not restore hidden odds through the `formattedMarkets` fallback. If no categories remain, show **Gösterilecek oran bulunmuyor.** and disable copy/download actions. Preserve current-match behavior and initialize the first visible category as open. Keep React hooks unconditional.

### Themes

- Support `default` (**Varsayılan tema**, existing navy appearance), `black` (**Siyah tema**), and `white` (**Beyaz tema**), in that menu order. Apply themes through the root HTML `data-theme` attribute and shared CSS variables; avoid fixed UI colors outside palette definitions and intentional theme swatches.
- The top-right **Tema** menu opens on mouse hover and supports touch/click and keyboard navigation. Preserve selected-option indicators, arrow-key navigation, outside-click/blur dismissal, and Escape closing with focus returned to the trigger.
- Store the preference under `oran-analiz-theme` in `localStorage`. Keep the pre-paint bootstrap in `web/frontend/index.html` aligned with the supported values in `web/frontend/src/utils/theme.js`. Missing/invalid preferences fall back to `default`; blocked storage must not prevent changing the current page's theme.
- Colored background animations belong only to the default theme. Theme changes must not reset searches, results, selected matches, or H2H scroll position. PNG exports retain their independent white design.

## Build, Test, and Development Commands

Run from the repository root unless noted:

```bash
npm install                         # Install server dependencies
npm run test:historical             # Run all web/tests/*.test.js regression tests
npm run build                       # Build the React frontend into web/frontend/dist
npm start                           # Start the Express server (usually port 3000)
cd web/frontend && npm run dev      # Start the Vite development server
cd web/frontend && npm run lint     # Run frontend lint checks
cd extension && node tests/test_suite.js
cd extension && node tests/test_ai_export.js
```

The extension integration suite uses live Nesine data and requires network access.

## Coding Style & Naming Conventions

Use ES modules, 4-space indentation, and semicolons in backend/extension JavaScript. Use `camelCase` for values, `PascalCase` for components/classes, and kebab-case asset paths. Keep market names and API mappings consistent with existing modules.

## Testing Guidelines

Node's built-in runner provides regression coverage; there is no coverage gate. `npm run test:historical` runs all `web/tests/*.test.js`, not just historical lookup tests:

- `historicalResolution.test.js`: aliases, daily-feed discovery, direct historical identity checks, unavailable archives, and false-positive protection.
- `sahadanH2h.test.js`: source selection, exact initial HTML rows, dates/scores, provenance, malformed tables, and provider failures. Keep Genoa–Como and Arsenal–Chelsea fixtures as deterministic source examples.
- `matchRequests.test.js`: independent odds/H2H lifetimes, stable history selection, clearing, cancellation, late responses, and subsequent searches.
- `theme.test.js`: supported preferences, persistence, blocked storage, and pre-paint bootstrap consistency.

After lookup changes, run the regression suite and a live query. For UI changes, run lint, build, and inspect the page. Check themes and responsive behavior at 320, 390, 768, and 1280 px, including menu hover/touch/keyboard operation. If browser tooling is unavailable, report the visual verification gap explicitly; static rendering and passing tests do not establish that mobile interaction or layout is correct.

## Commit, Pull Request & Deployment Guidelines

Use short imperative subjects, such as `Harden historical match lookup`. Pull requests must describe behavior, affected areas, and test results; include screenshots for UI work. Keep `netlify.toml` and `.github/workflows/` synchronized. GitHub Pages and Netlify use the Render API through `VITE_API_BASE_URL`; Render intentionally has no `render.yaml`.

## Security & Reliability

Never commit credentials or tokens. Treat scraped data and provider endpoints as fallible: retain timeouts, validation, deterministic daily-feed lookup, and clear fallback logging.

## Verification Snapshot — 2026-10-19

This is the latest recorded local verification, not a permanent test-count requirement or evidence of deployment. Refresh it when new checks are performed.

- 56 automated tests passed with `npm run test:historical` on standalone Node.js v24.22.0. New coverage includes provider cooldown/recovery, Retry-After formats, malformed Mackolik daily feeds, and trying later candidates after an individual request fails.
- Live local Roma–Genoa Sahadan H2H discovery returned 10 rows. A Mackolik daily-feed query for Roma–Genoa on 2025-01-17 returned one candidate. These checks do not establish odds-archive availability or access from Render.
- The production Render H2H endpoint returned `sahadan: HTTP 429` during the investigation. The local backend changes have not been deployed.
- The production frontend build with the Render API URL succeeded before publication. No frontend files changed; lint and browser interaction checks were not repeated. The earlier UI verification and its limitations are recorded below.

### Earlier Verification — 2026-09-08

- 45 automated tests passed; the production frontend build with the Render API URL succeeded. Lint exited successfully with four warnings: three unused callback parameters in `aiExportRenderer.js` and the selection-sync effect in `MatchSearch.jsx`.
- A live local Genoa–Como H2H query succeeded with 10 rows, half-time scores, and Sahadan provenance. The earlier 2026-09-05 checks compared Genoa–Como and Arsenal–Chelsea rows with their source HTML. Provider requests can intermittently return HTTP 429/502.
- The search form was visually inspected in Chrome at 320, 390, 768, and 1280 px, including default, black, and white themes and keyboard theme selection. No horizontal overflow was observed in the empty search form; the 390 px action buttons measured equal widths and 50 px heights. Full result/export layout, touch, and hover interaction coverage remains incomplete.
- These checks were performed before the requested GitHub and Netlify publication; this snapshot alone is not evidence of deployment.
