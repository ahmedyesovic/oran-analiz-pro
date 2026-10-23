# Publish match bands implementation plan

**Goal:** Publish the approved band classifier to VDS, Netlify and GitHub Pages, enriching legacy archives on demand.

**Authorization:** User tested locally and explicitly requested GitHub, both public sites and VDS deployment. This supersedes the earlier local-only constraint for this release. Never store credentials.

## Implementation

- [x] Add regression tests first for exact-ID enrichment, persistence, provider/malformed/empty failure fallback, retry-after/15-minute suppression, parallel aliases and already-enriched cache hits.
- [x] Implement on-demand enrichment in MatchService. Validate complete result identity, provider and nonempty valid MS snapshot before replacing a legacy archive. Preserve old archive on failure, show an explicit warning, and persist next retry time. Coalesce by source/match ID/date. Bound the enrichment request to 30 seconds within the existing source deadline.
- [x] Run full regression suite, lint, build and local browser check. Review the enrichment change independently and fix important findings.

## Release

- [ ] Commit on `codex/publish-match-bands`, push the branch only; retain main until backend verified.
- [ ] Take a private SQLite online backup with quick_check; prepare `/opt/oran-analiz-band-stage` with separate data directory `/var/lib/oran-analiz-band-stage` and loopback port3001. Run tests/build as application user and pace live provider checks sequentially.
- [ ] Stop staging, pause audit timer during promotion, retain previous production directory and promote real staging checkout to `/opt/oran-analiz-pro`. Keep production `ORAN_DATA_DIR=/var/lib/oran-analiz`. Restart and verify health, exact legacy enrichment, current lookup, both sources, persistent cache. On failure restore previous code directory; no database restore unless independently necessary.
- [ ] Fast-forward GitHub main to the verified release; confirm Netlify and GitHub Pages deploy the same source and VDS URL. Test public searches, row selection, clear, themes/responsive layouts and sample exports. Record actual evidence and leave local frontend configured for localhost.

## Progress

- Preflight: GitHub/local/VDS base `0ddf011`; production active.159 saved archives, all missing MS snapshots. SQLite outside checkout; previous API/hosting configuration remains valid. SSH key available; password unnecessary.
- Implementation verification:239 tests pass; lint has four existing warnings; frontend build and 12 viewport/theme browser cases pass. Independent review found retry persistence and parent-deadline fallback edges; failing regressions reproduced both, fixes retain in-memory retry suppression and reserve1s for cached fallback. Archive save must succeed before reporting it saved.
