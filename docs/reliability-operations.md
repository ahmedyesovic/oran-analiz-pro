# Reliability operations

Use Node.js 24 with the pinned `better-sqlite3` dependency. Keep durable app data outside the checkout: production `ORAN_DATA_DIR=/var/lib/oran-analiz` stores `data.sqlite`, its SQLite sidecars and the latest `reliability-audit.json`. Give this directory to `oran-analiz`, restrict access, and retain it across releases. The production service must explicitly set both `NODE_ENV=production` and `ORAN_DATA_DIR`; development/tests otherwise use the store's memory default. Moving hosts requires the SQLite backup and this environment setting, independently of the checkout path. Do not put the database or reports in Git or a public static directory.

## Native Mackolik discovery

The current bulletin, recent results and daily-feed order remain first. If those
do not resolve a completed Mackolik match, the server queries Mackolik's own
`/ajax/search` team autocomplete and native `/takim/.../ma%C3%A7lar/{teamId}`
fixtures. Source-advertised season links permit one previous season without an
explicit date, or at most two overlapping seasons with one. Known Mackolik IDs
skip autocomplete; Sahadan IDs are never assumed equivalent.

Season labels may include a short tournament location, such as `2008 Japan`.
Their leading year determines overlap and ordering; the advertised label and
URL remain intact during navigation and response verification. Team name
aliases such as `Man. United` and `Man. Utd` use the shared web/extension matcher
and retain all squad qualifiers.

Unselected generic labels such as `United`, `City` and `Real` require a full
name or explicit team selection before a pair/H2H query contacts providers.
One locally cached generic record cannot silently select the intended club.
Selected app IDs still require the existing ID/name/squad binding. A selected
historical match ID/date, or an exact code in a mode that actually uses that
code, retains its normal direct match verification. H2H never uses an odds code
to bypass team identity validation.

Only explicitly completed fixture rows are discovery candidates. The archive
must independently match the fixture's stable ID, both team IDs, calendar date
and completed score. Fixture values are never used as odds. The existing archive
parser still admits only verified Nesine markets, retaining a verified match
without odds when no Nesine archive is available.

The native stage gets up to 30 seconds, using at most half of the remaining
request budget. It is still attempted when earlier stages leave less than 30
seconds; the other half remains available for web fallback. Missing or
malformed native responses remain provider errors if no later path succeeds;
Mackolik 429 stops further attempts. Explicit historical ID/date selections
still open that archive directly.

If native/daily/archive access and search engines both fail, the response keeps
the Mackolik error's status and retry policy and includes the search failure as
additional context. A search-only cooldown must not mask a Mackolik failure or
impose its cooldown on a later native attempt.

## Free web-search fallback

Mackolik discovery retains DuckDuckGo and also uses Bing and Brave HTML search,
without API keys or paid accounts. The engines are shuffled once per logical
web lookup and tried sequentially. Current Nesine results, recent results,
Mackolik daily feeds, native team fixtures and explicit historical selections
keep their priority; they do not issue additional search-engine requests when sufficient.

A search HTTP 202/403 or a recognized HTTP-200 challenge places that engine in
a durable five-minute bot cooldown. HTTP 429 respects `Retry-After` and any
longer existing cooldown. DuckDuckGo's two hostnames share cooldowns and request
slots. Other engines remain available independently. The ordinary provider
coordinator still enforces the total deadline and source concurrency limits.

The browser fallback opens discovered Mackolik match URLs; it never restarts a
DuckDuckGo search. A rate limit on the Mackolik archive itself stops further
archive requests. Changing discovery engines cannot avoid that provider limit.
All free engines can be blocked at once: inspect structured `source-request`
host/status logs and distinguish this from valid empty results. No CAPTCHA
solving or proxy service is configured.

## Online backup

Use SQLite's online backup API. Copying only `data.sqlite` while WAL writes are active can lose committed data or produce an inconsistent copy. Run the following from the release checkout after creating a private backup directory writable by the application user. The command uses the installed dependency; no download or external service is needed.

```sh
sudo install -d -o oran-analiz -g oran-analiz -m 0700 /var/backups/oran-analiz
cd /opt/oran-analiz-pro
sudo -u oran-analiz env ORAN_DATA_DIR=/var/lib/oran-analiz ORAN_BACKUP_DIR=/var/backups/oran-analiz /usr/local/bin/node --input-type=module <<'NODE'
import Database from 'better-sqlite3';
import path from 'node:path';
const stamp = new Date().toISOString().replaceAll(':', '-');
const target = path.join(process.env.ORAN_BACKUP_DIR, `data-${stamp}.sqlite`);
const source = new Database(path.join(process.env.ORAN_DATA_DIR, 'data.sqlite'), { readonly: true, fileMustExist: true });
try {
    await source.backup(target);
    const backup = new Database(target, { readonly: true, fileMustExist: true });
    try {
        if (backup.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Backup integrity check failed');
    } finally { backup.close(); }
    console.log(target);
} finally { source.close(); }
NODE
```

Run with a private umask (`umask 077`) so the backup remains private. Keep dated backups and the previous application version before rollout. Copy a completed, closed backup to another host if needed; do not copy live WAL files as a substitute for this API. Verify restore compatibility before upgrading a schema; an old release may not understand a new database schema.

## Restore

Stop the audit timer, wait for any active audit to finish, and stop the application service before replacing any database. Stop a staging service too if it was ever pointed at that directory. Confirm there are no application processes holding the database. First retain a fresh online backup while the service is still running if possible. After stopping it, retain the existing `data.sqlite`, `data.sqlite-wal` and `data.sqlite-shm` together in a private quarantine directory. Never combine a restored database with sidecars from a different database.

With all database users stopped, verify `quick_check` on the intended backup through `better-sqlite3`, install it as a temporary file in the data directory with owner `oran-analiz`, group `oran-analiz` and mode `0600`, then rename it to `data.sqlite`. Ensure old `data.sqlite-wal` and `data.sqlite-shm` have been moved aside, not left beside the restored file. Start the application, check `/api/health` and one saved historical selection using its stable ID and date, then restart the audit timer. SQLite creates new sidecars as needed. On failure, stop the service again before restoring the quarantined database set; never replace an open database.

## Isolated staging and rollout

Create a separate checkout such as `/opt/oran-analiz-staging`. Run it as the application user on loopback port `3001`, with `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=3001`, and **a different** `ORAN_DATA_DIR=/var/lib/oran-analiz-staging`. Do not symlink that directory to production. Use an online backup to seed staging if needed. Restrict staging to loopback. Both listeners still share the VDS public IP, so pace live checks and never run parallel provider audits. A staging database has independent cooldown state and must not be used to evade a production cooldown.

Run deterministic tests, frontend lint and build before deployment. Verify the exact reported spellings with both archive choices where available; a verified completed match without a Nesine archive is a supported outcome, not a fabricated successful odds result. Check the stable historical row flow, restart/outage cache recovery, both deployed frontend flows and PNG exports, and 320/390/768/1280 px theme and combobox interactions. Record which checks were actually performed and any provider or visual gaps. A successful health endpoint alone does not establish provider availability. Retain the previous checkout/release and SQLite backup, and keep production `ORAN_DATA_DIR` unchanged when switching code.

## Daily local audit

`web/scripts/reliabilityAudit.js` sends only ordinary application API calls. The API applies its normal provider queue, cache, deadlines and persistent cooldown. It makes no direct provider requests and never flushes a cache or adds a bypass parameter. Each request has a 125-second client timeout, slightly longer than the API's 120-second coordinated deadline. Requests are sequential: health, odds and independent H2H for one pair, then the next pair, then one optional team search. There are no script retries. A 429, or a 503 with `Retry-After`, defers later probes of that route; an H2H cooldown also defers team search because both use Sahadan. An odds failure does not suppress independent H2H, and vice versa. The report explicitly marks deferred probes as failures, preserving HTTP status and a sanitized `Retry-After` without provider response bodies or exception messages.

The two selected pairs rotate through eight exact reported inputs, covering the cycle in four runs:

| Home | Away |
| --- | --- |
| Real Madrid | Sevillia |
| Bayer Leverkusen | Freiburg |
| Manchester City | Ipswich Town |
| Real Betis | Barcelona |
| Valencia | Athletico Bilbao |
| Roma | Genoa |
| Strasbourg | PSG |
| Den Haag | PSV |

Odds always specify `source=mackolik`; H2H always uses its independent Sahadan endpoint. This daily budget does not establish Sahadan odds-archive availability for every pair. Team discovery queries the first selected home name; set `ORAN_AUDIT_TEAM_SEARCH=0` to omit this optional request.

The atomic, private latest report `ORAN_DATA_DIR/reliability-audit.json` also persists the next rotation index. It is capped at 64 KiB, replaces the previous run, and contains only summaries: counts, source, date, stable match ID, `checkedAt`, cache saved time/staleness, and HTTP/error metadata. It retains no raw provider bodies or credentials and does not grow an unlimited history. A corrupt/unreadable rotation report stops the audit before any requests; inspect or restore it instead of silently resetting rotation. A failed replacement retains the prior report. Run only one monitor instance for a data directory; systemd prevents its timer from overlapping its active service. Do not manually start a second process concurrently.

`availability=cached-archive` and `cached=true` mean an already verified saved archive was available. `archiveCache.fromCache=false` means the API returned a newly recorded result; it is shown as `availability=api-response`. Older API responses with cache metadata but no `fromCache` are conservatively treated as cached. `stale=true` identifies explicit stale fallback. An API response without cache metadata can still use an internal transport cache. Therefore **every probe has `freshProviderVerification=false`**: this API-only monitor never claims fresh direct-source verification. A fresh provider-access audit needs separately recorded direct-source evidence through the normal coordinator, with dates/status and no cache bypass; it must respect the same cooldown. A cached success demonstrates archive availability at `checkedAt`, not new provider access.

Install the provided units only after staging and release verification. The units assume `/usr/local/bin/node`, `/opt/oran-analiz-pro`, application user `oran-analiz`, and an existing writable `/var/lib/oran-analiz`; adjust executable/checkout paths if your host differs. Confirm the application service has matching data-directory settings. Installation and enablement are explicit deployment actions, not performed by creating these files.

```sh
sudo install -m 0644 ops/oran-analiz-audit.service /etc/systemd/system/oran-analiz-audit.service
sudo install -m 0644 ops/oran-analiz-audit.timer /etc/systemd/system/oran-analiz-audit.timer
sudo systemctl daemon-reload
sudo systemctl enable --now oran-analiz-audit.timer
systemctl list-timers oran-analiz-audit.timer
journalctl -u oran-analiz-audit.service --no-pager -n 20
```

The timer runs daily at 03:30 **Europe/Istanbul**, with persistent catch-up after downtime. An audit with failed/deferred probes writes the report and exits nonzero; systemd records failure without automatic restart or retry. A storage failure logs only `AUDIT_REPORT_FAILED` and leaves the old report; compare its `checkedAt` with the last service run. Journal output is a compact local summary. There are no remote alerts, email, paid monitoring services, or notifications to other people. The latest JSON and journal must be reviewed locally. To disable scheduling, use `sudo systemctl disable --now oran-analiz-audit.timer`; it does not stop an already active audit.

For an explicitly authorized manual staging audit, run the script once as the application user with `ORAN_AUDIT_BASE_URL=http://127.0.0.1:3001` and `ORAN_DATA_DIR=/var/lib/oran-analiz-staging`. Do not enable a second daily timer against staging or use it to bypass an existing provider cooldown.
