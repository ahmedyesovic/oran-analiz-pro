# Native discovery rollout — 2026-10-30

The user explicitly authorized the current post-rollback local state on the VDS
and both public sites. Release `ea4f371f883817666e704fa4e2ea8c68177d2706` was
promoted at 19:38:28 UTC. The reverted country/current-selection/H2H-cache
changes are excluded; unrelated AGENTS.md edits and ignored credentials were
not included in the immutable release.

## Safeguards and checks

- Local regressions: 365 passed. Production frontend build passed. Lint passed
  with the four existing warnings; no frontend source or dependencies changed.
- Online SQLite backup passed `quick_check=ok`:
  `/var/backups/oran-analiz/before-native-ea4f371-20261030T193400Z.sqlite`.
- Independent staging copied production data, including cooldowns. All 365
  tests passed on Node.js v24.22.0 in 31.19 seconds. Tests used isolated in-memory
  stores; the copied production data was reserved for the real staging probe.
- The staging probe returned 52 verified Nesine markets for the completed
  Chelsea–Man. United archive on 2026-04-18. The staging service was stopped.
- Previous code is retained at
  `/opt/oran-analiz-pro-before-native-ea4f371-20261030T193826Z`.
- Production data remains `/var/lib/oran-analiz`. No schema migration or data
  replacement was performed. Application, Caddy and audit timer are active.
  External HTTPS health returned `status=ok`.

## Public sites

The actual Netlify and GitHub Pages forms were tested sequentially with exact
`Chelsea` / `Manchester United` inputs, Mackolik selected and no selected team
IDs. Both sent requests to `https://oran-api.185-23-75-42.sslip.io` and returned:

- HTTP 200, 56 current Nesine markets, match date 31.10.2026.
- HTTP 200, 10 Sahadan initial-table rows. Netlify fetched the table; GitHub
  Pages received a fresh verified cached table (`stale=false`).
- No JavaScript errors or horizontal overflow at 1280px. The Netlify desktop
  screenshot was visually inspected. Mobile/themes and PNG exports were not
  rechecked. These public form probes used current odds; historical discovery
  was exercised separately by the real staging probe.

Live artifacts: `/private/tmp/oran-live-sites-chelsea-report.json`,
`/private/tmp/oran-live-netlify-chelsea.png` and
`/private/tmp/oran-live-github-pages-chelsea.png`.

Both existing live JS bundles and the new production build are byte-identical:
SHA256 `e81cd9e7f3d7c2b073bab2eee2f8f7e9fa7593d1534937f95668d50909650026`.
Their unchanged static frontends use the newly deployed shared API; no static
rebuild/publication was required or claimed.

## GitHub source publication

During the initial VDS rollout, the connected GitHub tool lacked write access
and local Git had no authenticated write credential. The VDS and both public
frontends were updated and verified independently of source publication.

The user then explicitly authorized source publication and completed the
official GitHub CLI device flow. The authenticated login was independently
verified as `ahmedyesovic`, and repository push access was verified before the
write. GitHub main advanced without force from `33fcd59` to the exact deployed
release `ea4f371f883817666e704fa4e2ea8c68177d2706` at approximately 20:31 UTC.

[Pages workflow 41123880202](https://github.com/ahmedyesovic/oran-analiz-pro/actions/runs/41123880202)
completed successfully for that commit. The repository's `API_BASE_URL` remains
`https://oran-api.185-23-75-42.sslip.io`. No new backend change or VDS restart
was needed for source publication. Netlify already used the updated shared API;
no manual Netlify redeployment was performed. Unrelated AGENTS.md edits remain
local and were excluded from publication.
