# Publish native Mackolik discovery and free search fallback

The user explicitly requested the current local state on the VDS and both
public sites on 2026-10-30. Publish the state after the requested rollback:
native Mackolik discovery, free randomized search fallback, Manchester United
aliases, named-season support and ambiguous-name validation. The reverted
country/current-selection/H2H-cache changes are excluded.

Local regression: 365 tests passed. Frontend lint exits successfully with the
four existing warnings. Production build succeeds and matches the existing
static asset names. Keep local dist using its existing local API configuration.
Existing unrelated AGENTS.md edits and ignored credentials are excluded.

Deployment sequence:

1. Create a local immutable commit/bundle containing only the release files.
2. Back up production SQLite with its online API and verify integrity. Retain
   the current code directory and production data directory/cooldowns.
3. Prepare independent staging code/data from that backup. Run the complete
   regression suite and a real query before promotion.
4. Promote to the existing service path, restart and check health/HTTPS. Restore
   previous code if promotion checks fail.
5. Verify both live frontend forms against the updated shared API. No frontend
   source changes or redeployment are required for identical static bundles.
6. Publish source to GitHub after verifying authenticated repository write
   access. The initial connector was read-only; the user later completed an
   independent GitHub CLI login, verified as `ahmedyesovic` before publication.

## Outcome

Release `ea4f371` is active on the VDS after online backup, 365 staging tests and
a real 52-market historical probe. Both live forms subsequently returned 56
current Nesine markets and 10 Sahadan rows. Existing static bundles are
byte-identical to the production build and use the updated shared API. Source
publication to GitHub completed for the exact `ea4f371` release after the user
authorized the direct login. Pages workflow `41123880202` succeeded and uses
the existing VDS API variable.
See `docs/verification-2026-10-30-native-search-rollout.md` for actual evidence
and limits.
