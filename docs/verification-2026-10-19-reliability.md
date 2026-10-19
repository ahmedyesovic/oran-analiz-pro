# Reliability release verification — 2026-10-19

Application revision: `a55778643d3885c97a7c21e9a2e20cb55101ba53` (`Make team lookup and verified archives durable`). This record distinguishes deterministic tests, VDS staging probes, production checks and browser checks; none guarantees future upstream availability.

## Automated and build checks

- All 218 web regression tests passed on Node.js v24.22.0 in the isolated checkout, after integration into local `main`, and on the VDS staging checkout. These include actual SQLite reopen, scoped team identity and squad rejection, verified archive evidence, provider concurrency/retry/cooldown/deadlines, stale H2H fallback and transport abort, suggestion request lifetimes, audit rotation and existing frontend behavior.
- Final independent scoped review approved the three earlier findings and archive hydration/grouping; its 33 focused regression tests passed. No blocking identity bypass remained in that reviewed scope.
- Frontend lint succeeded with the four existing warnings: three unused exporter callback parameters and the MatchSearch selection synchronization effect. Frontend production builds succeeded locally and on the VDS.
- The standalone extension suites were not rerun; their previously recorded missing export/file blockers are unchanged. Web tests exercise the real extension normalizer.

## VDS staging provider audit

Staging used loopback port 3001 and a separate `/var/lib/oran-analiz-stage/data.sqlite`; production was still on the earlier application during the initial audit. The eight exact reported inputs and two canonical repetitions were queried sequentially with both odds sources and independent Sahadan H2H. Counts below are returned formatted markets and exact initial-table H2H rows at verification time.

| Home / away input | Mackolik | Sahadan | H2H |
| --- | ---: | ---: | ---: |
| Real Madrid / Sevillia | 50 | 101 | 10 |
| Bayer Leverkusen / Freiburg | 51 | 91 | 10 |
| Manchester City / Ipswich Town | 49 | 99 | 10 |
| Real Betis / Barcelona | 51 | 101 | 10 |
| Valencia / Athletico Bilbao | 51 | 93 | 10 |
| Roma / Genoa | 51 | 93 after recovery | 10 |
| Strasbourg / PSG | 50 | 99 | 10 |
| Den Haag / PSV | 47 | 78 | 10 |

Canonical `Real Madrid / Sevilla` and `Valencia / Athletic Bilbao` repetitions also succeeded with their corresponding counts. All reported odds results identified Nesine as provider and passed pair verification. The initial Roma Sahadan probe returned HTTP 502 even after the coordinator's single automatic retry; a subsequent normal dated query recovered 93 verified markets. The failure is retained as part of the evidence, not counted as an initial success.

Final staging checks after all fixes verified one Den Haag suggestion, both selected opaque team IDs through each odds source (47/78 markets) and H2H (10 rows), and a direct saved ID/date selection after restart. A separate online SQLite backup supported a controlled outage drill: the exact stored archive returned without any provider calls, valid stale H2H recovered, and an uncached query retained a provider failure. This was a controlled application-level outage drill; the VDS network was not disabled.

## Production release and operations

- Production application checkout: `/opt/oran-analiz-pro`, revision `a557786`; clean tracked working tree. Explicit service environment: `NODE_ENV=production`, `ORAN_DATA_DIR=/var/lib/oran-analiz`. The service and Caddy HTTPS endpoint are active.
- Durable data: `/var/lib/oran-analiz/data.sqlite`; SQLite online backup seeded from the verified staging database and passed `quick_check`. Data file, backup and audit report have mode 0600 and application ownership; the enclosing data/backup directories are private.
- Previous checkout: `/opt/oran-analiz-pro-before-a557786`. Retained online backup: `/var/backups/oran-analiz/staging-verified-a557786.sqlite`. See [backup/restore procedures](reliability-operations.md) before replacing any open SQLite database.
- The first attempted symlink promotion did not start the server because the existing main-module guard compares the real module path with argv. Automatic rollback restored the previous application. The successful promotion retained a real checkout directory at the existing service path; no application code changed after the tested revision.
- Production health and exact Den Haag/PSV archive were verified: HTTP success, 47 Nesine markets, correct match ID `amb531b6gw4qltbvmqqsrauxg`, date 2026-10-17, explicit saved-archive metadata. External HTTPS team-search returned one main-team Den Haag suggestion.
- Staging service is stopped. `oran-analiz-audit.timer` is enabled, daily 03:30 Europe/Istanbul. The first audit exited 0 with `ok:true` for Real Madrid/Sevillia and Bayer Leverkusen/Freiburg. Latest private report: `/var/lib/oran-analiz/reliability-audit.json`. This API-only audit explicitly does not claim fresh direct-source verification and sends no external alerts.
- Netlify published `a557786` in deploy `6ad636032aeee432790b027a`. [GitHub Pages workflow 39277565286](https://github.com/ahmedyesovic/oran-analiz-pro/actions/runs/39277565286) completed successfully. Both public sites served `index-CJtsT3Pg.js` and `index-CPkqiRO2.css` and use the same VDS API.

## Browser verification

Local native Chrome inspection covered 320 px/default, 390 px/black, 768 px/white and 1280 px/default, plus a populated white result. The search controls fitted the viewport; the equal search/clear buttons stayed side by side. Keyboard and pointer combobox selection, editing, Escape, clear focus, historical row selection and H2H scroll preservation were checked. Den Haag/PSV returned the correct 2026-10-17 archive and 10 H2H rows; a single-category PNG was valid at 2400 × 3680 (500,100 bytes).

On both live sites, exact `Den Haag / PSV` inputs each produced one canonical main-team suggestion. Keyboard Down/Enter selected them, then the correct archive (2026-10-17, code 3217274) and 10 H2H rows appeared. Native Chrome Network inspection on Netlify confirmed HTTP 200 for both odds and H2H and the same selected opaque home/away IDs in both requests. The odds response contained 47 formatted markets; the historical UI showed eight categories with KORNER & KART hidden.

Selecting the 17.10.2026 historical row on each site preserved the original H2H source, 10 rows and scroll position. Netlify Network inspection showed only the new odds request with stable match ID `amb531b6gw4qltbvmqqsrauxg` and date. Before/after screenshots were inspected. Separate single-category files `netlify-a557786-den-haag-psv-mackolik.png` and `pages-a557786-den-haag-psv-mackolik.png` were saved through Chrome; both valid PNG headers measured 2400 × 3680 and 500,541 bytes, and the exported layout was inspected.

The exact pair also succeeded with Sahadan selected on both live sites: correct 2026-10-17 17:30 archive and 10 H2H rows. Netlify Network preview showed 78 formatted markets and nine visible groups after the historical KORNER & KART filter. No new error appeared in those checks. The two live PNG checks above used Mackolik; a Sahadan PNG was not repeated in this release audit.

The complete width × theme matrix, desktop hover, physical touchscreen behavior, visual scrolling of eight suggestion options and all-category PNG export were not fully rechecked. Deterministic suggestion-scroll tests passed; those tests do not replace the omitted interaction checks.
