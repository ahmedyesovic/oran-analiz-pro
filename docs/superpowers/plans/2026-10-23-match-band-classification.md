# Automatic match band classification implementation plan

**Goal:** Show the user's B0–B7 Evb/Depb classification below the match title, using verified full-time Nesine 1-X-2 odds.

**Architecture:** Provider adapters retain a separate versioned MS snapshot with original decimal strings and explicit outcome states. A pure classifier runs in the common response builder; React renders its lines without changing PNG or clipboard output.

**Constraints:** Local work and local testing only; no deployment, push, remote changes or new dependencies. Preserve existing markets, caches, identity verification and independent H2H lifecycle. Missing/hidden/zero values are not proof of suspension. Old snapshots cannot recover precision from rounded markets.

## Tasks

- [x] 1. Add failing classifier and adapter tests, including decimal boundaries, closed states, invalid readings, provider proof, duplicate sets and legacy cache behavior.
- [x] 2. Implement `web/src/matchBand.js`: versioned snapshots, strict decimal parsing, validation and classification with Turkish display lines.
- [x] 3. Extract snapshots before existing filtering/rounding in Nesine, Mackolik and Sahadan; forward through the service/resolver and validate new cache metadata without invalidating old records.
- [x] 4. Render `bandClassification.lines` in MatchResult below the title, using shared palette variables; preserve export behavior and existing request lifetimes.
- [x] 5. Run all regression tests, frontend lint/build, local live provider query and browser checks. Review the complete change and record evidence/limitations.

## Acceptance

All boundaries, 1.355 → B2, tie, draw independence, ≤1.50 / >7.00 closed-side rules, out-of-band/suspicious/missing cases and conflicting sets are deterministic. Raw MS precision is retained while existing market display is unchanged. Legacy cache remains usable with an unavailable classification. Selection/clear/stale-response behavior stays coupled to the odds result, never H2H. Responsive layout supports 320/390/768/1280 px and all three themes.

## Progress and rulings

- Baseline: 218 regression tests pass on Node v24.22.0; working tree initially clean.
- Ruling: Work in the user's explicitly designated local folder; do not create a separate worktree or commit/publish implicitly.
- Ruling: The approved conversation plan is the binding design. Execute inline, with a final independent review as required by the execution skill.
- Tasks 1–4 complete: test-first classifier/adapters, additive API metadata, validated snapshots and shared screen-only rendering, including the no-odds fallback.
- Review fixes: repeated labels preserve separate sets instead of overwriting; hidden HTML quotes (including nested inline-hidden descendants) and crossed-out old quotes cannot supply the classification. Each correction reproduced with a failing test before its fix.
- Task 5 complete: 232/232 tests; frontend lint passes with four existing warnings; production build passes; 12 local viewport/theme cases and keyboard/hover/emulated-touch controls pass. Live local Nesine and both historical providers return expected codes. See `docs/verification-2026-10-23-match-band.md`.
- Local files remain uncommitted for user testing. No VDS, Netlify, GitHub Pages, deployment configuration or remote repository changes.
