# Publish both team bands

**Authorization:** The user tested the local feature successfully and explicitly requested publication to the VDS, GitHub, Netlify and GitHub Pages on 2026-10-26. This permission applies to this release. Credentials must never be stored.

**Scope:** Publish the already tested classifier, its tests and related verification documents. Existing unrelated AGENTS.md conversation additions remain in the local working tree. No frontend component, dependency or hosting configuration changes are necessary; both public frontends render the shared API's classification lines.

## Release steps

- [x] Confirm local, GitHub main and VDS baseline `fdbb36e`; check production service, timer and data directory. Repeat regressions/lint and review source changes.
- [x] Build the frontend using the production API URL in a temporary output directory, retaining the local build's same-origin API configuration.
- [x] Commit only this feature's files and release plan. Transfer an immutable Git bundle to the VDS; leave GitHub main unchanged until backend verification.
- [x] Back up production SQLite using its online API and verify `quick_check=ok`. Create an independent staging checkout/data directory, run all regression tests as the application user and verify the exact Genoa/Venezia query on loopback.
- [x] Retain the previous code directory and promote staging to the existing real `/opt/oran-analiz-pro` path, preserving `/var/lib/oran-analiz`. Restart, verify health and both band codes. Restore previous code automatically if promotion checks fail.
- [x] Push the verified commit to GitHub main; confirm Pages and Netlify publication. Verify Genoa/Venezia through both live frontends and record actual evidence and limitations.
- [x] Publish rollout documentation without triggering unnecessary frontend rebuilds; leave local configuration suitable for local testing.

## Verification target

For the verified 2026-10-25 Genoa/Venezia archive, original MS1 `1.87`, MSX `3.03`, MS2 `3.10` produce `B3 aralığında Evb3 · B5 aralığında Depb5`. Keep favorite `codes=['Evb3']` and both additive side bands. H2H remains independent, and classification remains excluded from clipboard/PNG output.

## Outcome

Release `3cc7ca0` passed 242 tests locally and in VDS staging. Both actual live frontend forms displayed Evb3, Depb5 and 10 H2H rows. Pages workflow `40344932738` succeeded. Netlify skipped its automatic build because frontend content was unchanged; manual retry deploy `6adf6c372b1a3d3452d96ec7` published the exact release successfully. See `docs/verification-2026-10-26-both-team-bands-rollout.md` for safeguards, evidence and coverage limits.
