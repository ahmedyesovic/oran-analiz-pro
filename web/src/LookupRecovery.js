import { RefreshCoordinator, refreshKey } from './RefreshCoordinator.js';
import { SourceError, isRetryableSourceError, logLookupObservation } from './sourceHttp.js';
import { verifiedArchive, verifiedHistory, jsonValue } from './verifiedCache.js';
import { teamNamesMatch } from '../../utils/normalize.js';

const activeStates = new Set(['queued', 'running', 'backoff']);
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
const refreshMetadata = job => ({ state: job?.state || 'idle', nextAttemptAt: job?.nextAttemptAt || null });
const latestWarning = 'En yeni maç kontrol edilemedi; son doğrulanmış arşiv gösteriliyor.';

// Foreground requests only observe background work. In particular, browser
// polling must not restart discovery, extend retry windows or cancel a worker.
export class LookupRecovery {
    constructor({ service, sahadan, store, resolvePair, clock = Date.now, cacheWaitMs = 2000,
        foregroundWaitMs = 25000, coordinatorOptions = {} }) {
        this.service = service;
        this.store = store;
        this.sahadan = sahadan;
        this.resolvePair = resolvePair;
        this.clock = clock;
        this.cacheWaitMs = cacheWaitMs;
        this.foregroundWaitMs = foregroundWaitMs;
        this.coordinator = new RefreshCoordinator({ store, clock, ...coordinatorOptions,
            run: request => this.run(request) });
    }

    async run({ kind, query }) {
        const mode = query.mode || 'auto';
        const resolved = kind === 'h2h' || mode === 'auto'
            ? await this.resolvePair(query) : { query, warning: null };
        const discovery = resolved.discoveryContext ? { discoveryContext: resolved.discoveryContext } : {};
        let result;
        let verificationError;
        if (kind === 'h2h') {
            const teams = await this.service.resolveTeams(resolved.query);
            result = await this.sahadan.headToHead(teams.home, teams.away, {
                teamIdentities: resolved.query.trustedTeamIdentities || teams.teamIdentities, refresh: true, ...discovery });
            if (resolved.warning) result = { ...result, resolutionWarning: resolved.warning };
        } else {
            result = await this.service.lookup(resolved.query, mode, { refresh: true, ...discovery });
            // Native schedules can lag behind a completed match. Use only the
            // verified, initially rendered Sahadan rows to detect a newer event,
            // then open that exact archive and independently verify it again.
            if (mode === 'auto' && result.isHistorical && !query.date && !query.matchId && !query.code
                && typeof this.sahadan.headToHead === 'function') {
                try {
                    const teams = await this.service.resolveTeams(resolved.query);
                    const history = await this.sahadan.headToHead(teams.home, teams.away, { teamIdentities: teams.teamIdentities, ...discovery });
                    if (!verifiedHistory(history, teams.home, teams.away, { teamIdentities: teams.teamIdentities })) {
                        throw new SourceError('Sahadan karşılaştırma sonucu doğrulanamadı.', 502);
                    }
                    if (history.archiveCache?.stale) throw new SourceError('Son tamamlanan maç doğrulanamadı.', 504);
                    const latest = history.matches.filter(row => teamNamesMatch(row.home, teams.home)
                        && teamNamesMatch(row.away, teams.away) && /^\d+ - \d+$/.test(row.score || ''))
                        .sort((a, b) => b.date.localeCompare(a.date))[0];
                    if (!latest || latest.date < result.match.date) throw new SourceError('Son tamamlanan maç doğrulanamadı.', 504);
                    if (latest.date > result.match.date) {
                        const currentWarnings = (result.warnings || []).filter(warning => /Güncel Nesine kontrolü başarısız/i.test(warning));
                        result = await this.service.lookup(resolved.query, 'historical', {
                            refresh: true, historicalHint: { id: latest.id, date: latest.date }, ...discovery });
                        result = { ...result, warnings: [...new Set([...currentWarnings, ...(result.warnings || [])])] };
                    }
                } catch (error) {
                    verificationError = error;
                    result = { ...result, warnings: [...(result.warnings || []),
                        'Son tamamlanan maç doğrulanamadı; gösterilen geçmiş maç en yeni karşılaşma olmayabilir.'] };
                }
            }
            if (resolved.warning) result = { ...result, warnings: [resolved.warning, ...(result.warnings || [])] };
        }
        const pinned = Boolean(query.matchId || query.date || query.code);
        const latestVerified = pinned ? null : !result.warnings?.some(warning =>
            /Güncel Nesine kontrolü başarısız|Son tamamlanan maç doğrulanamadı/i.test(warning));
        // Keep the source-proven squad decision with the original request key.
        // A later outage must not require rediscovering that decision just to
        // display the same, explicitly qualified and dated archived result.
        if (resolved.query.trustedTeamIdentities) this.store.setRecord('verified-resolutions', refreshKey(kind, query),
            jsonValue({ query: resolved.query, warning: resolved.warning }), { version: 1 });
        else this.store.deleteRecord('verified-resolutions', refreshKey(kind, query));
        const response = { ...result, latestVerified,
            lastLatestCheckedAt: latestVerified === true ? iso(this.clock()) : null };
        if (verificationError && !isRetryableSourceError(verificationError)) {
            verificationError.usableResult = response;
            throw verificationError;
        }
        return response;
    }

    async cached(kind, query) {
        if (kind === 'odds') return this.service.cachedLookup(query, query.mode || 'auto');
        const teams = await this.service.resolveTeams(query);
        return this.sahadan.cachedHeadToHead(teams.home, teams.away, { teamIdentities: teams.teamIdentities });
    }

    fresh(job, kind) {
        if (job?.state !== 'succeeded' || !job.result) return false;
        const age = this.clock() - Date.parse(job.lastSucceededAt);
        // Historical odds do not expire, but a pair's current/latest decision
        // does. Re-check that decision just as often as a current odds snapshot.
        const lifetime = kind === 'odds' ? 60000 : 900000;
        return age >= 0 && age < lifetime;
    }

    async savedResult(kind, query, job) {
        const result = job?.result;
        if (!result?.success || (query.mode === 'current') || query.code) return null;
        const resolution = this.store.getRecord('verified-resolutions', refreshKey(kind, query), { version: 1 });
        const expected = resolution?.value?.query || query;
        const teams = await this.service.resolveTeams(expected, { allowMatchReference: Boolean(query.matchId && query.date) });
        if (kind === 'h2h') {
            const age = this.clock() - Date.parse(result.archiveCache?.savedAt || job.lastSucceededAt);
            return age >= 0 && age <= 86400000 && verifiedHistory(result, teams.home, teams.away,
                { teamIdentities: teams.teamIdentities }) ? result : null;
        }
        if (!result.isHistorical || ((query.date || query.matchId) && result.dataSource !== query.source)) return null;
        return verifiedArchive(result, { ...teams, source: result.dataSource }) ? result : null;
    }

    response(result, job, { stale = false } = {}) {
        const warnings = result.warnings || [];
        return { ...result, refresh: refreshMetadata(job),
            ...(stale ? { latestVerified: false,
                archiveCache: result.archiveCache && { ...result.archiveCache, stale: true },
                warnings: [...new Set([...warnings, latestWarning])] } : {}) };
    }

    unavailable(job) {
        const next = Date.parse(job?.nextAttemptAt);
        const retryable = activeStates.has(job?.state) || job?.error?.retryable === true;
        const error = new SourceError(job?.error?.message || 'Kaynak kontrolü sürüyor; sonuç otomatik olarak yeniden denenecek.',
            job?.error?.status || 503, { retryable,
                errorCode: job?.error?.errorCode || (retryable ? 'SOURCE_RECOVERING' : 'PROVIDER_UNAVAILABLE'),
                ...(retryable ? { retryAfter: Math.max(1, Math.ceil((Number.isFinite(next) ? next - this.clock() : 5000) / 1000)) } : {}) });
        error.refresh = refreshMetadata(job);
        return error;
    }

    async lookup(kind, query, { observe = false, signal, foregroundWaitMs = this.foregroundWaitMs } = {}) {
        if (!Number.isSafeInteger(foregroundWaitMs) || foregroundWaitMs <= 0 || foregroundWaitMs > 120000) {
            throw new RangeError('Ön plan bekleme süresi 1 ile 120000 ms arasında olmalıdır.');
        }
        let job = this.coordinator.get(kind, query);
        const logObservation = () => logLookupObservation({ lookupId: this.coordinator.lookupId(kind, query),
            kind, observe, state: job?.state || 'idle' });
        try {
            const primary = await this.cached(kind, query);
            const previous = await this.savedResult(kind, query, job);
            const date = result => kind === 'odds' ? result?.match?.date || '' : result?.archiveCache?.savedAt || '';
            const cached = previous && (!primary || date(previous) > date(primary)) ? previous : primary;
            if (this.fresh(job, kind)) return this.response(job.result, job);
            const pinned = Boolean(query.matchId && query.date);
            // A selected completed archive has no latest-pair question. A missing
            // optional MS snapshot can be refreshed without delaying its odds.
            if (kind === 'odds' && cached && pinned) {
                if (!observe && cached.hasOdds && cached.matchResultOdds === undefined && !job) {
                    job = this.coordinator.request(kind, query);
                }
                return this.response(cached, job);
            }
            if (!observe) {
                try {
                    job = this.coordinator.request(kind, query, { force: Boolean(job && !activeStates.has(job.state)) });
                } catch (error) {
                    if (cached) return this.response(cached, job, { stale: true });
                    throw error;
                }
            }
            if (job && activeStates.has(job.state) && !observe && !(kind === 'h2h' && cached)) {
                job = await this.coordinator.wait(kind, query, {
                    timeoutMs: cached ? this.cacheWaitMs : foregroundWaitMs, signal });
            } else if (job && activeStates.has(job.state) && !cached) {
                job = await this.coordinator.wait(kind, query, { timeoutMs: foregroundWaitMs, signal });
            }
            if (this.fresh(job, kind)) return this.response(job.result, job);
            const completed = await this.savedResult(kind, query, job);
            const retained = completed && (!cached || date(completed) >= date(cached)) ? completed : cached;
            if (retained) return this.response(retained, job, { stale: true });
            throw this.unavailable(job);
        } finally {
            logObservation();
        }
    }

    close() { this.coordinator.close(); }
}
