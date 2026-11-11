import { NesineService } from './nesineService.js';
import { HistoricalOddsSourceResolver } from './HistoricalOddsSourceResolver.js';
import { SourceError, withSourceDeadline, getSourceRemainingMs, getSourceDeadlineSignal } from './sourceHttp.js';
import { getReliabilityStore } from './reliabilityStore.js';
import { getTeamDirectory, TeamDirectory } from './teamDirectory.js';
import { ARCHIVE_VERSION, archiveKey, pairKey, archiveMetadata, verifiedArchive, saveVerified, providerTeamIds, jsonValue } from './verifiedCache.js';
import { classifyMatchBand, validMsSnapshot } from './matchBand.js';
import { isAmbiguousTeamName, teamIdentity, teamNamesMatch } from '../../utils/normalize.js';
import { isPair, normalizeSahadanMatch } from './sahadanParser.js';

export function normalizeResponse(result) {
    const formattedMarkets = Object.values(result.markets || {}).flatMap(group => Object.entries(group)
        .filter(([, odds]) => Object.keys(odds).length)
        .map(([category, odds]) => ({ category, odds: Object.entries(odds).map(([name, value]) => ({ name, value })) })));
    return {
        ...result, success: true, hasOdds: formattedMarkets.length > 0,
        bandClassification: classifyMatchBand(result.matchResultOdds, result.oddsProvider === 'nesine'),
        status: formattedMarkets.length ? 'FOUND' : 'ODDS_NOT_FOUND', formattedMarkets,
        matchName: result.match.name, matchDate: result.match.date, matchTime: result.match.time,
        matchCode: result.match.code, sourceUrl: result.match.sourceUrl, score: result.match.score,
        historicalMessage: formattedMarkets.length ? null : `${[result.match.name, result.match.date, result.match.score ? `Skor: ${result.match.score}` : null].filter(Boolean).join(' · ')}: ${result.dataSource} kaynağında doğrulanmış Nesine oranı bulunamadı.`
    };
}

export class MatchService {
    constructor({ nesine = new NesineService(), historical, store = getReliabilityStore(), directory, clock = Date.now } = {}) {
        this.nesine = nesine;
        this.store = store;
        this.directory = directory || (store === getReliabilityStore() ? getTeamDirectory() : new TeamDirectory({ store }));
        this.historical = historical || new HistoricalOddsSourceResolver({ store, directory: this.directory });
        this.pending = new Map();
        this.enrichmentPending = new Map();
        this.enrichmentRetryUntil = new Map();
        this.clock = clock;
    }

    lookup(query, mode = 'auto') {
        const key = JSON.stringify([mode, query.home, query.away, query.source, query.date, query.matchId, query.code, query.homeTeamId, query.awayTeamId, query.trustedTeamIdentities, query.trustedSourceMatchId, query.trustedSourceMatchDate]);
        if (this.pending.has(key)) return this.pending.get(key);
        const promise = withSourceDeadline(() => this.lookupResolved(query, mode));
        this.pending.set(key, promise);
        promise.finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); }).catch(() => {});
        return promise;
    }

    async resolveTeams(query, { allowMatchReference = false } = {}) {
        const resolved = { ...query, teamIdentities: {} };
        const hasTrustedMatchId = query.trustedSourceMatchId !== undefined && query.trustedSourceMatchId !== null;
        const hasTrustedMatchDate = query.trustedSourceMatchDate !== undefined && query.trustedSourceMatchDate !== null;
        if (hasTrustedMatchId || hasTrustedMatchDate) {
            const value = query.trustedSourceMatchDate;
            if (!query.trustedTeamIdentities || !hasTrustedMatchId || !hasTrustedMatchDate
                || typeof query.trustedSourceMatchId !== 'string'
                || !/^[a-z0-9]{1,64}$/.test(query.trustedSourceMatchId)
                || typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
                || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
                throw new SourceError('Otomatik maç kimliği ve tarihi doğrulanamadı.', 400);
            }
        }
        if (query.trustedTeamIdentities !== undefined) {
            const identities = query.trustedTeamIdentities;
            const ids = [];
            if (query.homeTeamId || query.awayTeamId || query.matchId || query.date || query.code) {
                throw new SourceError('Seçilen takım kimliği ile otomatik kadro kimliği birleştirilemez.', 400);
            }
            for (const side of ['home', 'away']) {
                const team = identities?.[side];
                const providers = team?.providers;
                if (!teamIdentity(query[side]).name || teamIdentity(query[side]).qualifiers !== 'women'
                    || !Array.isArray(providers) || providers.length !== 1
                    || providers[0]?.source !== 'sahadan'
                    || typeof providers[0]?.providerId !== 'string'
                    || !/^[a-z0-9]{1,64}$/.test(providers[0].providerId)) {
                    throw new SourceError('Otomatik takım veya kadro kimliği doğrulanamadı.', 400);
                }
                const id = providers[0].providerId;
                ids.push(id);
                resolved.teamIdentities[side] = { providers: [{ source: 'sahadan', providerId: id }] };
            }
            if (ids[0] === ids[1]) throw new SourceError('Otomatik takım kimlikleri farklı olmalıdır.', 400);
            return resolved;
        }
        for (const side of ['home', 'away']) {
            const id = query[`${side}TeamId`];
            if (!id && !allowMatchReference && isAmbiguousTeamName(query[side])) {
                throw new SourceError(`“${query[side]}” birden fazla takımı ifade edebilir. Tam takım adını yazın veya listeden bir takım seçin.`, 400);
            }
            const team = await this.directory.resolve({ id, name: query[side] });
            if (id && !team) throw new SourceError('Seçilen takım doğrulanamadı. Takımı listeden yeniden seçin.', 400);
            if (team) {
                resolved[side] = team.name;
                resolved.teamIdentities[side] = team;
            }
        }
        return resolved;
    }

    cachedArchive(query, key) {
        const record = this.store.getRecord('verified-archives', key, { version: ARCHIVE_VERSION });
        if (!record || !verifiedArchive(record.value, query)
            || key !== archiveKey(query.source, record.value.match.id, record.value.match.date)) return null;
        // Missing archives can be published later, so unavailable odds are not permanent.
        if (!normalizeResponse(record.value).hasOdds && Date.now() - record.savedAt > 86400000) return null;
        return normalizeResponse({ ...record.value, isHistorical: true, archiveCache: archiveMetadata(record) });
    }

    recordEnrichmentRetry(key, until) {
        this.enrichmentRetryUntil.set(key, until);
        try { this.store.setRecord('band-enrichment-attempts', key, { until }); }
        catch (error) { console.error(JSON.stringify({ event: 'band_retry_write_failed', error: error.code || error.name })); }
    }

    async enrichCachedArchive(query, cached) {
        if (cached.matchResultOdds !== undefined || !cached.hasOdds) return cached;
        const key = archiveKey(query.source, cached.match.id, cached.match.date);
        const fallback = () => ({ ...cached, warnings: [...(cached.warnings || []),
            'Bant bilgisi güncellenemedi; kayıtlı oranlar gösteriliyor. MS verisi daha sonra yeniden denenecek.'] });
        // Reserve time for returning cached odds instead of racing the outer deadline.
        const budget = Math.min(30000, getSourceRemainingMs() - 1000);
        if (budget <= 0) return fallback();
        let pending = this.enrichmentPending.get(key);
        if (!pending) {
            const attempt = this.store.getRecord('band-enrichment-attempts', key, { version: 1 });
            if (Math.max(this.enrichmentRetryUntil.get(key) || 0, Number.isSafeInteger(attempt?.value?.until) ? attempt.value.until : 0) > this.clock()) return fallback();
            // Persist before contacting the provider so restarts do not cause a retry burst.
            this.recordEnrichmentRetry(key, this.clock() + 900000);
            pending = (async () => {
                try {
                    const exact = { ...query, matchId: cached.match.id, date: cached.match.date };
                    const result = await withSourceDeadline(() => this.historical.resolveHistoricalOdds(exact), { timeoutMs: budget });
                    if (!result || !verifiedArchive(result, exact) || !normalizeResponse(result).hasOdds
                        || !validMsSnapshot(result.matchResultOdds) || !result.matchResultOdds.sets.length
                        || !result.matchResultOdds.sets.every(set => ['MS1', 'MS2'].some(label => ['open', 'closed'].includes(set[label].state)))) {
                        return null;
                    }
                    this.store.setRecord('verified-archives', key, jsonValue(result), { version: ARCHIVE_VERSION });
                    return normalizeResponse({ ...result, isHistorical: true, archiveCache: { savedAt: new Date(this.clock()).toISOString(), fromCache: false, stale: false } });
                } catch (error) {
                    const retryMs = Number(error.retryAfter) * 1000;
                    const until = this.clock() + Math.max(900000, Number.isFinite(retryMs) && retryMs > 0 ? retryMs : 0);
                    if (Number.isSafeInteger(until)) this.recordEnrichmentRetry(key, until);
                    return null;
                }
            })();
            this.enrichmentPending.set(key, pending);
            pending.finally(() => { if (this.enrichmentPending.get(key) === pending) this.enrichmentPending.delete(key); }).catch(() => {});
        }
        let updated;
        try { updated = await withSourceDeadline(() => pending, { timeoutMs: budget }); }
        catch { return fallback(); }
        return updated && verifiedArchive(updated, { ...query, matchId: cached.match.id, date: cached.match.date }) ? updated : fallback();
    }

    async bindDiscoveredTeams(query, result) {
        // Do not replace Sahadan-verified IDs with a same-name record from
        // another provider. The match detail below independently proves them.
        if (query.trustedTeamIdentities) return query;
        const teamIdentities = { ...query.teamIdentities };
        const existingIds = providerTeamIds(teamIdentities, query.source);
        for (const side of ['home', 'away']) {
            if (existingIds[side]) continue;
            const raw = this.directory.lookupProvider?.(query.source, result.match?.[`${side}ProviderId`]);
            // Scrapers record names only after canonical match, date, result and
            // team-ID checks. Resolve the original query against that evidence;
            // a result's provider ID alone cannot authorize a name change.
            const verified = raw && await this.directory.resolve({ id: raw.id, name: query[side] });
            if (verified) teamIdentities[side] = verified;
        }
        return { ...query, teamIdentities };
    }

    async verifyTrustedCurrent(query, result) {
        const fail = () => { throw new SourceError('Güncel maçın takım ve olay kimliği doğrulanamadı.'); };
        const match = result?.match;
        const ids = providerTeamIds(query.teamIdentities, 'sahadan');
        const id = query.trustedSourceMatchId;
        const sourceDate = query.trustedSourceMatchDate;
        if (!ids.home || !ids.away || !id || !sourceDate || typeof this.historical.sahadan?.detail !== 'function'
            || !match || !teamNamesMatch(match.home, query.home) || !teamNamesMatch(match.away, query.away)) return fail();
        const code = String(match.code ?? '');
        if (!/^\d+$/.test(code) || match.date !== sourceDate) return fail();
        const detail = await this.historical.sahadan.detail(id);
        const actual = detail?.match;
        if (!actual || actual.uuid !== id || !['Fixture', 'Playing'].includes(actual.status)
            || !isPair(actual, query.home, query.away, false, ids)) return fail();
        const normalized = normalizeSahadanMatch(actual);
        const sourceCode = String(normalized.code ?? '');
        if (normalized.date !== sourceDate || !/^\d+$/.test(sourceCode) || sourceCode !== code) return fail();
    }

    async verifyTrustedResult(query, result) {
        if (!query.trustedTeamIdentities) return;
        const ids = providerTeamIds(query.teamIdentities, 'sahadan');
        if (!ids.home || !ids.away || typeof this.historical.sahadan?.detail !== 'function') {
            throw new SourceError('Otomatik maç kimliği Sahadan ile doğrulanamadı.');
        }
        const detail = await this.historical.sahadan.detail(result.match.id);
        const actual = detail?.match;
        const normalized = actual && normalizeSahadanMatch(actual);
        if (!actual || actual.uuid !== result.match.id || actual.status !== 'Played'
            || !isPair(actual, query.home, query.away, false, ids)
            || normalized.date !== result.match.date || normalized.score !== result.match.score) {
            throw new SourceError('Otomatik maçın takım, tarih ve sonucu doğrulanamadı.');
        }
    }

    async lookupResolved(input, mode) {
        // Selected archives and exact bulletin codes already identify one
        // match. Their ordinary provider identity checks remain authoritative;
        // free pair searches and H2H still require a specific team name.
        const allowMatchReference = Boolean((input.matchId && input.date) || (input.code && !input.date && mode !== 'historical'));
        const query = await this.resolveTeams(input, { allowMatchReference });
        const warnings = [];
        const errors = [];
        if (query.matchId && query.date) {
            const cached = this.cachedArchive(query, archiveKey(query.source, query.matchId, query.date));
            if (cached) return this.enrichCachedArchive(query, cached);
        }
        if (!query.date && mode !== 'historical') {
            let current = null;
            try {
                current = await this.nesine.current(query);
            } catch (error) {
                if (mode === 'current' || query.code) throw error;
                errors.push(error);
                warnings.push(`Güncel Nesine kontrolü başarısız: ${error.message}`);
            }
            if (current) {
                // Bulletin names alone cannot distinguish same-named squads;
                // bind the event to the verified Sahadan UUIDs and Iddaa code.
                if (query.trustedTeamIdentities) await this.verifyTrustedCurrent(query, current);
                return normalizeResponse(current);
            }
            if (mode === 'current' || query.code) throw new SourceError('Güncel maç bulunamadı.', 404);
        }
        let recent = null;
        if (!query.date) {
            try { recent = await this.nesine.recent(query.home, query.away); }
            catch (error) {
                errors.push(error);
                warnings.push('Son tamamlanan maç doğrulanamadı; gösterilen geçmiş maç en yeni karşılaşma olmayabilir.');
            }
        }
        const date = query.date || recent?.date;
        const pair = !query.trustedTeamIdentities && this.store.getRecord('archive-pairs', pairKey(query), { version: ARCHIVE_VERSION, maxAgeMs: 3600000 });
        if (!query.matchId && pair && (!date || pair.value.date === date)) {
            const cached = this.cachedArchive({ ...query, date: date || pair.value.date }, pair.value.key);
            if (cached) {
                const response = await this.enrichCachedArchive(query, cached);
                return { ...response, warnings: [...warnings, ...(response.warnings || [])] };
            }
        }
        // Only an unpinned pair can use an alternate archive. Explicit historical
        // selections must keep their original source, date, and stable match ID.
        const mayUseAlternate = !query.date && !query.matchId && !query.code;
        const remaining = getSourceRemainingMs();
        const primaryBudget = mayUseAlternate && remaining > 3000
            ? Math.min(25000, Math.max(1000, remaining - 20000)) : remaining;
        let effectiveQuery = { ...query, date };
        let result;
        let trustedResultVerified = false;
        let primarySignal;
        try {
            result = await withSourceDeadline(() => {
                primarySignal = getSourceDeadlineSignal();
                return this.historical.resolveHistoricalOdds(effectiveQuery);
            }, { timeoutMs: primaryBudget });
        } catch (primaryError) {
            // Malformed payloads, identity errors and provider 404 are not
            // transport failures and cannot be silently hidden by fallback.
            const upstream = primaryError?.upstreamStatus;
            const transportFailure = primaryError instanceof SourceError && (
                primaryError.status === 504 || upstream === 429
                || (upstream >= 500 && upstream <= 599)
                || (primaryError.status === 502 && /kaynağa bağlantı kurulamadı/i.test(primaryError.message))
            );
            const alternateBudget = Math.min(20000, getSourceRemainingMs() - 1000);
            if (!mayUseAlternate || !transportFailure || alternateBudget <= 0) throw primaryError;
            const alternate = query.source === 'mackolik' ? 'sahadan' : 'mackolik';
            const alternateQuery = { ...query, source: alternate, date };
            try {
                const candidate = await withSourceDeadline(
                    () => this.historical.resolveHistoricalOdds(alternateQuery), { timeoutMs: alternateBudget });
                const verified = candidate && await this.bindDiscoveredTeams(alternateQuery, candidate);
                // Only nonempty, independently verified Nesine odds may replace
                // a transport failure; an empty archive cannot hide it.
                if (!candidate || !verifiedArchive(candidate, verified) || !normalizeResponse(candidate).hasOdds) throw primaryError;
                await this.verifyTrustedResult(verified, candidate);
                trustedResultVerified = true;
                result = candidate;
                effectiveQuery = alternateQuery;
                warnings.push(`${query.source} kaynağına ulaşılamadı; doğrulanmış ${alternate} arşivi gösteriliyor.`);
            } catch {
                // If our own budget stopped the primary (not an upstream 429),
                // allow a bounded retry when the alternate cannot help. Keep at
                // least 30 seconds for a higher-level unqualified-pair resolver.
                const retryBudget = Math.min(20000, getSourceRemainingMs() - 30000);
                const stoppedByBudget = primaryError.status === 504 && !primaryError.upstreamStatus
                    && !primaryError.retryAfter && primarySignal?.aborted && primarySignal.reason === primaryError;
                if (!stoppedByBudget || retryBudget < 5000) throw primaryError;
                try {
                    const retry = await withSourceDeadline(
                        () => this.historical.resolveHistoricalOdds(effectiveQuery), { timeoutMs: retryBudget });
                    const verified = retry && await this.bindDiscoveredTeams(effectiveQuery, retry);
                    if (!retry || !verifiedArchive(retry, verified)) throw primaryError;
                    result = retry;
                } catch {
                    throw primaryError;
                }
            }
        }
        if (!result) {
            if (errors.length) throw errors.find(error => error.retryAfter) || errors[0];
            throw new SourceError(`${query.source}: aranan kapsamda tamamlanmış maç bulunamadı.`, 404);
        }
        const verifiedQuery = await this.bindDiscoveredTeams(effectiveQuery, result);
        if (!verifiedArchive(result, verifiedQuery)) throw new SourceError('Geçmiş maç sonucu ve Nesine oran kaynağı doğrulanamadı.');
        if (!trustedResultVerified) await this.verifyTrustedResult(verifiedQuery, result);
        const key = archiveKey(effectiveQuery.source, result.match.id, result.match.date);
        saveVerified(this.store, 'verified-archives', key, result, { version: ARCHIVE_VERSION });
        if (!query.date && !query.matchId && !query.trustedTeamIdentities) saveVerified(this.store, 'archive-pairs', pairKey(effectiveQuery), { key, date: result.match.date }, { version: ARCHIVE_VERSION });
        return normalizeResponse({ ...result, isHistorical: true, warnings });
    }
}

export function validateQuery(query, { pairRequired = false } = {}) {
    for (const key of ['home', 'away', 'code', 'date', 'source', 'matchId', 'homeTeamId', 'awayTeamId']) {
        if (query[key] != null && (typeof query[key] !== 'string' || query[key].length > 120)) throw new SourceError('Geçersiz arama parametresi.', 400);
    }
    let home = query.home?.trim();
    let away = query.away?.trim();
    if (home && !away) {
        const parts = home.split(/\s+(?:-|–|—|vs\.?|\/)\s+/i);
        if (parts.length === 2) [home, away] = parts.map(part => part.trim());
    }
    const source = query.source || 'mackolik';
    if (!['mackolik', 'sahadan'].includes(source)) throw new SourceError('Kaynak Mackolik veya Sahadan olmalıdır.', 400);
    if ((pairRequired || query.matchId || !query.code || query.date) && (!home || !away)) throw new SourceError('Ev sahibi ve deplasman takımları zorunludur.', 400);
    for (const key of ['homeTeamId', 'awayTeamId']) {
        if (query[key] != null && !/^team_[a-f0-9]{64}$/.test(query[key])) throw new SourceError('Geçersiz takım kimliği.', 400);
    }
    if (query.code && !/^\d+$/.test(query.code)) throw new SourceError('Geçersiz maç kodu.', 400);
    if (query.matchId != null && !/^[a-z0-9]{1,64}$/.test(query.matchId)) throw new SourceError('Geçersiz geçmiş maç kimliği.', 400);
    if (query.matchId && (!query.date || query.code)) throw new SourceError('Geçmiş maç kimliği tarih ile kullanılmalı; güncel maç koduyla birleştirilemez.', 400);
    if (query.date && (!/^\d{4}-\d{2}-\d{2}$/.test(query.date) || !Number.isFinite(Date.parse(query.date)) || new Date(query.date).toISOString().slice(0, 10) !== query.date)) throw new SourceError('Tarih YYYY-MM-DD biçiminde geçerli bir gün olmalıdır.', 400);
    return { home, away, code: query.code, source, date: query.date || null, matchId: query.matchId || null, ...(query.homeTeamId ? { homeTeamId: query.homeTeamId } : {}), ...(query.awayTeamId ? { awayTeamId: query.awayTeamId } : {}) };
}
