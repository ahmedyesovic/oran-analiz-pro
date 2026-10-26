# Local verification — both team bands — 2026-10-26

The band card now shows the favorite's existing code followed by the other side's code, using each side's own original full-time Maç Sonucu odds. Existing favorite `band` and `codes` fields remain unchanged. Additive `sideBands.MS1` / `sideBands.MS2` metadata identifies each band, or `null` when it cannot be established. The existing closed-favorite B0 assumption is explicitly marked `inferred: true` and retains its explanation.

Only local source, tests and documentation were changed. No commits, pushes, remote repository operations, VDS access, deployment or remote configuration changes were performed.

## Automated verification

- Runtime: standalone Node.js v24.22.0.
- Baseline: 239/239 web regression tests passed.
- Test-first evidence: eight classifier tests failed against the original code when the new side-band expectations were added; all 17 classifier tests passed after implementation.
- Final `npm run test:historical`: 242 tests passed, zero failures or skips.
- `npm --prefix web/frontend run lint`: successful, with four existing warnings (three unused parameters in aiExportRenderer.js and the MatchSearch.jsx state-sync effect).
- `VITE_API_BASE_URL='' VITE_BASE_PATH='/' npm --prefix web/frontend run build`: successful; local/same-origin API configuration retained.
- `git diff --check` for the changed application/test/plan files: successful. The existing AGENTS.md archive already contains two trailing-space Markdown line breaks outside this change; those were preserved.
- Independent read-only review found no actionable defects and checked additional nonfavorite precision boundaries and inferred-versus-observed duplicate sets.

## Browser verification

`web/tests/browser/matchBand.mjs` passed using local headless Chrome and its injected deterministic API. Both side codes were asserted at 320, 390, 768 and 1280 px with default, black and white themes: 12 combinations. There was no viewport overflow. Historical selection changed both band codes while retaining H2H request count, source URL and scroll position. Clear, late-response cancellation, subsequent search, keyboard/hover and emulated touch theme behavior passed. Clipboard output excluded band classification.

Screenshots were generated in the OS temporary `oran-band-ui` directory; 320/default and 1280/white were visually inspected. At narrow widths the combined code line wraps inside its card. A native Safari localhost tab was opened, but a user-driven tab change interrupted the live form interaction; that attempt is not counted as a live browser result. Browser layout/interaction evidence above comes from the completed Chrome harness. Physical touch and PNG downloads were not rechecked; no export code changed.

## Live local source query

The local application was started at `http://localhost:3000`, bound to `127.0.0.1`, in development mode with its normal in-memory local store.

The exact query `home=Genoa&away=Venezia&source=mackolik` returned HTTP 200 and a verified Nesine odds archive:

- Match date: `2026-10-25`; score: `1 - 0`.
- Source match ID: `7gixui89fwmbgbcvk99xl0v10`; Iddaa code: `3236214`.
- Original odds: MS1 `1.87`, MSX `3.03`, MS2 `3.10`.
- Display: **B3 aralığında Evb3 · B5 aralığında Depb5**.
- [Verified source page](https://www.mackolik.com/mac/genoa-vs-venezia/iddaa/7gixui89fwmbgbcvk99xl0v10).

The local health endpoint also returned `{"status":"ok"}`. These checks establish this local query's result at verification time. The VDS and both public frontends were left unchanged.
