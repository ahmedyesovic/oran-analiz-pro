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
6. Publish source to GitHub only if authenticated write access is available.
   The current GitHub connector is read-only and local Git has no authenticated
   write credential; report this limitation without claiming a source push.
