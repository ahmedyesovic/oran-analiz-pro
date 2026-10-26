# Both team bands implementation plan

**Goal:** Show the home Evb code and away Depb code together, each calculated from its own original full-time MS odds.

**Design:** Extend the existing pure classifier and its display lines. Keep `band` and `codes` as the existing favorite classification; add `sideBands` keyed by `MS1` and `MS2`, with `{ band, code }` or `null`. A closed favorite inferred by the existing rule also carries `inferred: true`. Show the favorite first, followed by the other side's own band on the same wrapping line. Ties keep their existing joint wording.

**Architecture:** The shared response builder recalculates classification from current or cached original MS snapshots. The existing React card renders the combined line without frontend component or export changes.

**Constraints:** Work in the user's designated local copy, preserving existing AGENTS.md edits. No commits, pushes, PRs, merges, server access, deployment, dependency changes, cache migrations or remote configuration changes. Keep existing original-decimal comparisons, provider verification, suspicious/missing/closed odds rules and H2H lifecycle.

**Approach:** Extend backend display lines and add side metadata, rather than recalculate odds in React or change the meaning of the existing favorite fields. The shared calculation covers Nesine, both historical providers and cached snapshots consistently.

## Tasks

- [x] 1. Add failing tests for independent home/away bands, exact decimal boundaries, favorite compatibility, closed/missing outcomes and opponent-only conflicts across duplicate MS sets.
- [x] 2. Add side-band metadata and combined lines to `web/src/matchBand.js`. Compare both side bands when duplicate sets are checked; keep invalid/conflicting/unverified results free of codes.
- [x] 3. Extend `web/tests/browser/matchBand.mjs` to check both codes across all 12 viewport/theme combinations and historical selection, retaining cancellation, H2H and clipboard checks.
- [x] 4. Run regressions, frontend lint/build and local Chrome verification; inspect screenshots. Run a local live Genoa/Venezia lookup and report provider limitations honestly. Obtain an independent code review and record evidence.

## Acceptance examples

- Illustrative MS1 `1.90`, MSX `2.90`, MS2 `4.50`: `B3 aralığında Evb3 · B6 aralığında Depb6`.
- MS1 `9.00`, MS2 `1.355`: `B2 aralığında Depb2 · B7 aralığında Evb7`; favorite fields remain `B2` / `['Depb2']`.
- MS1/MS2 both `2.45`: existing tie wording and two `B4` side codes.
- Explicitly closed favorite with opposite odds above `7.00`: preserve the existing assumed `B0`, mark it inferred, and add the observed opposite side's actual band. Other closed/missing states never gain an invented band.
- Duplicate sets that agree on the favorite but disagree on the opponent band are conflicting, with no displayed classification.
- PNG and clipboard remain unchanged; search selection, clearing, themes and H2H retain their state behavior.

## Progress

- Initial state: `main` in the user's local copy; only AGENTS.md already modified. Node v24.22.0 and existing dependencies available.
- All implementation and verification will stay local and uncommitted for the user's testing.
- Baseline: 239/239 regression tests. New expectations failed in eight classifier tests before implementation; all 17 classifier tests passed after it.
- Final: 242/242 regressions; lint succeeded with four pre-existing warnings; local frontend build succeeded; 12 viewport/theme browser cases and interaction checks passed. Independent review found no actionable bugs.
- Live local Genoa/Venezia query resolved the 2026-10-25 Mackolik archive: MS1 `1.87`, MSX `3.03`, MS2 `3.10`; `Evb3` and `Depb5` displayed in the response lines. Details: `docs/verification-2026-10-26-both-team-bands.md`.
