import { AsyncResource } from 'node:async_hooks';
import { teamIdentity, isAmbiguousTeamName } from '../../utils/normalize.js';
import { sameTeam, isPair, selectH2hSource, normalizeSahadanMatch } from './sahadanParser.js';
import { SourceError, withSourceDeadline, getSourceDeadlineSignal } from './sourceHttp.js';

const validId = value => typeof value === 'string' && /^[a-z0-9]{1,64}$/.test(value);
const badEvidence = () => new SourceError('Sahadan takım veya maç kimliği doğrulanamadı.', 502);
const terminal = (status, query, extra = {}) => ({ status, home: query.home, away: query.away, ...extra });

/**
 * Create once while building the app, outside a request deadline. The async
 * resource gives shared discovery its own bounded lifecycle rather than making
 * a second caller inherit the first caller's cancellation.
 */
export class PairVariantResolver {
    constructor({ sahadan, verifyPrimary, clock = Date.now, ttlMs = 15000, timeoutMs = 28000, maxTeamCandidates = 8, maxPairs = 8 } = {}) {
        if (!sahadan || typeof sahadan.pairCandidates !== 'function' || typeof sahadan.api !== 'function'
            || typeof sahadan.detail !== 'function' || typeof verifyPrimary !== 'function') {
            throw new TypeError('Sahadan discovery and primary bulletin verification are required.');
        }
        this.sahadan = sahadan;
        this.verifyPrimary = verifyPrimary;
        this.clock = clock;
        this.ttlMs = Math.max(0, Math.min(ttlMs, 30000));
        this.timeoutMs = Math.max(1, Math.min(timeoutMs, 30000));
        this.maxTeamCandidates = Math.max(1, Math.min(maxTeamCandidates, 20));
        this.maxPairs = Math.max(1, Math.min(maxPairs, 20));
        this.pending = new Map();
        this.cache = new Map();
        this.resource = new AsyncResource('PairVariantResolver');
    }

    resolve(query, { signal = getSourceDeadlineSignal() } = {}) {
        if (signal?.aborted) return Promise.reject(signal.reason);
        if (!query?.home || !query?.away || query.homeTeamId || query.awayTeamId || query.matchId || query.date || query.code
            || teamIdentity(query.home).qualifiers || teamIdentity(query.away).qualifiers
            || isAmbiguousTeamName(query.home) || isAmbiguousTeamName(query.away)) return Promise.resolve(terminal('preserve', query || {}));
        const key = JSON.stringify([query.home, query.away, query.teamIdentities || null]);
        const cached = this.cache.get(key);
        if (cached && cached.expires > this.clock()) return Promise.resolve(cached.value);
        if (cached) this.cache.delete(key);
        let record = this.pending.get(key);
        if (!record) {
            record = { controller: new AbortController(), consumers: 0, settled: false };
            this.pending.set(key, record);
            const work = this.resource.runInAsyncScope(() => withSourceDeadline(
                () => this.discover(query), { timeoutMs: this.timeoutMs, signal: record.controller.signal }
            ));
            record.promise = work.then(result => {
                if (!record.controller.signal.aborted && record.consumers > 0 && this.ttlMs > 0
                    && ['main', 'alternate'].includes(result.status)) {
                    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value);
                    this.cache.set(key, { value: result, expires: this.clock() + this.ttlMs });
                }
                return result;
            }).finally(() => {
                record.settled = true;
                if (this.pending.get(key) === record) this.pending.delete(key);
            });
        }
        record.consumers++;
        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = () => {
                if (finished) return false;
                finished = true;
                signal?.removeEventListener('abort', abort);
                record.consumers--;
                if (!record.settled && record.consumers === 0) {
                    if (this.pending.get(key) === record) this.pending.delete(key);
                    const reason = new Error('Aday aramasının tüm bekleyenleri ayrıldı.');
                    reason.name = 'SourceSupersededError';
                    record.controller.abort(reason);
                }
                return true;
            };
            const abort = () => { if (finish()) reject(signal.reason); };
            if (signal?.aborted) return abort();
            signal?.addEventListener('abort', abort, { once: true });
            record.promise.then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); });
        });
    }

    async teams(name) {
        const result = await this.sahadan.api('home-search', { e: 'sss', migration_status: 'perform', autocomplete: 1, search: name });
        if (!Array.isArray(result?.data)) throw badEvidence();
        if (result.hasMore === true || result.has_more === true || result.next || result.nextCursor
            || result.pagination?.hasMore === true || result.pagination?.next) return null;
        const teamRows = result.data.filter(item => item?.type === 1);
        if (teamRows.length >= 50) return null;
        const candidates = new Map();
        for (const team of teamRows) {
            if (typeof team.name !== 'string' || !team.name.trim() || !validId(team.uuid)) throw badEvidence();
            if (sameTeam(team.name, name)) candidates.set(team.uuid, team);
        }
        return candidates.size >= this.maxTeamCandidates ? null : [...candidates.values()];
    }

    async discover(query) {
        // A failed bulletin check is not proof that no current main-team match exists.
        if (await this.verifyPrimary(query)) return terminal('main', query);
        const primary = await this.sahadan.pairCandidates(query.home, query.away, { teamIdentities: query.teamIdentities });
        if (!Array.isArray(primary)) throw badEvidence();
        if (primary.length) return terminal('main', query);
        const home = query.home + ' (K)';
        const away = query.away + ' (K)';
        const [homes, aways] = await Promise.all([this.teams(home), this.teams(away)]);
        if (homes === null || aways === null) return terminal('ambiguous', query);
        if (!homes.length || !aways.length) return terminal('not-found', query);
        if (homes.length * aways.length > this.maxPairs) return terminal('ambiguous', query);
        const pairs = [];
        for (const h of homes) {
            for (const a of aways) {
                if (h.uuid === a.uuid) continue;
                const teamIdentities = {
                    home: { providers: [{ source: 'sahadan', providerId: h.uuid }] },
                    away: { providers: [{ source: 'sahadan', providerId: a.uuid }] }
                };
                const expectedIds = { home: h.uuid, away: a.uuid };
                const candidates = await this.sahadan.pairCandidates(home, away, { teamIdentities });
                if (!Array.isArray(candidates)) throw badEvidence();
                for (const candidate of candidates) {
                    if (!validId(candidate?.uuid) || !isPair(candidate, home, away, true, expectedIds)) throw badEvidence();
                }
                if (!candidates.length) continue;
                const selected = selectH2hSource(candidates, home, away, new Date(this.clock()), expectedIds);
                if (!selected) throw badEvidence();
                pairs.push({ selected, expectedIds });
                if (pairs.length > 1) return terminal('ambiguous', query);
            }
        }
        if (!pairs.length) return terminal('not-found', query);
        const { selected, expectedIds } = pairs[0];
        const detail = await this.sahadan.detail(selected.uuid);
        const actual = detail?.match;
        const before = normalizeSahadanMatch(selected);
        const after = actual && normalizeSahadanMatch(actual);
        if (!after || actual.uuid !== selected.uuid || !isPair(actual, home, away, true, expectedIds)
            || actual.status !== selected.status || !before.date || after.date !== before.date
            || (actual.status === 'Played' && (!/^\d+ - \d+$/.test(after.score || '') || after.score !== before.score))) throw badEvidence();
        return { status: 'alternate', home, away, sourceMatchId: actual.uuid, sourceMatchDate: after.date,
            teamIds: expectedIds };
    }
}
