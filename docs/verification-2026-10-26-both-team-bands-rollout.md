# Both team bands rollout — 2026-10-26

The user explicitly authorized publishing the locally reviewed dual-band change to the VDS, GitHub main, Netlify and GitHub Pages. Feature commit `3cc7ca0cdf464f444b89b0b6ce07a3d4c96d95bb` is on GitHub main and the VDS; both frontend deployments completed successfully. Future changes remain subject to the repository's local-first rule and require their own publication authorization.

## VDS safeguards and verification

- An online SQLite backup passed `quick_check`: `/var/backups/oran-analiz/before-both-bands-3cc7ca0-20261026T145603Z.sqlite`.
- Independent staging copied code/dependencies and used separate data cloned from that backup, retaining provider cooldowns. All 242 regression tests passed. Its temporary service listened only on loopback port 3001 and was stopped afterward.
- Promotion allowed a 90-second systemd stop grace. Previous code remains at `/opt/oran-analiz-pro-before-both-bands-3cc7ca0-20261026T145725Z`.
- Production data remains at `ORAN_DATA_DIR=/var/lib/oran-analiz`; no database migration or production-data replacement was performed.
- The production service and audit timer are active. The audit service was already failed during preflight and was not rerun; this release does not establish audit-service recovery.

Production loopback and external HTTPS verification of the exact Genoa/Venezia query resolved the verified archive for `2026-10-25`, match ID `7gixui89fwmbgbcvk99xl0v10`, Iddaa code `3236214`. Original odds MS1 `1.87`, MSX `3.03`, MS2 `3.10` produced **B3 aralığında Evb3 · B5 aralığında Depb5**. Existing favorite `band` and `codes` behavior is unchanged; opponent information is additive.

## Public frontends

- Native Chrome searches using the actual [Netlify](https://oran-analiz-pro.netlify.app) and [GitHub Pages](https://ahmedyesovic.github.io/oran-analiz-pro/) forms with exact inputs Genoa/Venezia showed both codes and 10 Sahadan H2H rows. The Netlify desktop screenshot was visually inspected.
- [GitHub Pages workflow 40344932738](https://github.com/ahmedyesovic/oran-analiz-pro/actions/runs/40344932738) completed successfully.
- The local production frontend build succeeded with unchanged output filenames `index-D5gkqYi7.js` and `index-CPkqiRO2.css`. Local `dist` retained its localhost configuration. The existing frontend renders classification `lines` from the shared VDS API, so no frontend component or configuration change was needed for the new text.

## Netlify publication

Automatic deploy `6adf6ae4fc1d820f0a9e29ad` for `3cc7ca0` appeared as an error in the public API. Its dashboard log identified the actual cause: `Canceled build due to no content change` during the content-change check. No frontend source had changed; the existing frontend already rendered both codes from the updated VDS API. No application fix or hosting configuration change was needed.

Using **Retry with latest branch commit** started manual deploy `6adf6c372b1a3d3452d96ec7`. The official Netlify API confirmed `state=ready`, the exact `3cc7ca0` commit and `published_at=2026-10-26T15:05:43.469Z`. [Netlify deployment](https://app.netlify.com/projects/oran-analiz-pro/deploys/6adf6c372b1a3d3452d96ec7).

## Verification limits

No PNG downloads or new mobile/theme checks were performed during this release. The preceding [local verification](verification-2026-10-26-both-team-bands.md) covered 12 viewport/theme combinations; those checks are separate from the live release verification. Provider availability is established only for the reported requests at verification time. No credentials were stored in this record.
