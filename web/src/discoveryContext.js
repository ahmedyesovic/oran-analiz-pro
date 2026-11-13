import { explicitTeamAlias, normalizeTeamName, teamIdentity, teamNamesMatch } from '../../utils/normalize.js';
import { providerTeamIds } from './verifiedCache.js';
import { normalizeSahadanMatch, isPair } from './sahadanParser.js';
import { SharedSourceReads } from './SharedSourceReads.js';
import { SourceError, assertSourceDeadline, getSourceDeadlineSignal, withIndependentSourceDeadline,
    withSourceDependencies, sourceDependenciesValid, logDiscoveryJoin } from './sourceHttp.js';

const sourcePaths = {
    sahadan: /^\/mac\/([^/\\]+)\/([a-z0-9]{1,64})$/,
    mackolik: /^\/mac\/([^/\\]+)\/iddaa\/([a-z0-9]{1,64})$/
};
const shared = new WeakMap();
const evidence = new WeakMap();
const id = value => typeof value === 'string' && /^[a-z0-9]{1,64}$/.test(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const date = value => /^\d{2}\.\d{2}\.\d{4}$/.test(value || '') ? value.split('.').reverse().join('-') : value;
const nameKey = name => [explicitTeamAlias(name)?.name || normalizeTeamName(name), teamIdentity(name).qualifiers];
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function key(source, query) {
    const ids = providerTeamIds(query.teamIdentities, source);
    return JSON.stringify([source, nameKey(query.home), ids.home, nameKey(query.away), ids.away, query.date || null]);
}
function reference(source, raw, query) {
    if (source === 'sahadan') {
        const ids = providerTeamIds(query.teamIdentities, source);
        const value = normalizeSahadanMatch(raw);
        if (!id(value.id) || !id(value.homeProviderId) || !id(value.awayProviderId) || !day(value.date)
            || (query.date && value.date !== query.date) || !['Playing','Fixture','Played'].includes(value.status) || !isPair(raw, query.home, query.away, true, ids)
            || (value.status === 'Played' && !/^\d+ - \d+$/.test(value.score || ''))) return null;
        return { id: value.id, home: value.home, away: value.away, homeProviderId: value.homeProviderId,
            awayProviderId: value.awayProviderId, date: value.date, dateTimeUtc: raw.date_time_utc,
            status: value.status, score: value.score, sourceUrl: value.sourceUrl, code: value.code };
    }
    if (source !== 'mackolik') return null;
    const matchDate = date(raw.matchDate || query.date);
    const ids = providerTeamIds(query.teamIdentities, source);
    const matches = side => ids[side] ? raw[side + 'TeamId'] === ids[side]
        && teamIdentity(raw[side + 'TeamName']).qualifiers === teamIdentity(query[side]).qualifiers
        : teamNamesMatch(raw[side + 'TeamName'], query[side]);
    if (typeof raw.score !== 'string' || !/^\d+ - \d+$/.test(raw.score) || (query.date && query.date !== matchDate) || !id(raw.matchId) || !id(raw.homeTeamId) || !id(raw.awayTeamId) || !day(matchDate) || !matches('home') || !matches('away')) return null;
    return { id: raw.matchId, home: raw.homeTeamName, away: raw.awayTeamName,
        homeProviderId: raw.homeTeamId, awayProviderId: raw.awayTeamId, date: matchDate,
        dateTimeUtc: null, status: 'Played', score: raw.score || null, sourceUrl: raw.url, code: null };
}
function candidates(context) {
    return context.candidates.map(ref => {
        if (context.source === 'mackolik') return { url: ref.sourceUrl, matchId: ref.id,
            title: `${ref.home} - ${ref.away} ${ref.date.split('-').reverse().join('.')}`,
            matchDate: ref.date, score: ref.score, homeTeamId: ref.homeProviderId, awayTeamId: ref.awayProviderId,
            homeTeamName: ref.home, awayTeamName: ref.away };
        const score = ref.score?.split(' - ').map(Number);
        return { uuid: ref.id, slug: ref.sourceUrl.split('/')[4],
            team_A: { uuid: ref.homeProviderId, name: ref.home, display_name: ref.home },
            team_B: { uuid: ref.awayProviderId, name: ref.away, display_name: ref.away },
            date_time_utc: ref.dateTimeUtc, status: ref.status,
            fts_A: score?.[0] ?? null, fts_B: score?.[1] ?? null, extras: { iddaa_code: ref.code } };
    });
}
export class DiscoveryContextCache {
    constructor({ clock = Date.now, limit = 100, ttlMs = 300000 } = {}) {
        this.clock = clock;
        this.limit = Math.max(1, Math.min(100, limit));
        this.ttlMs = Math.max(0, Math.min(300000, ttlMs));
        this.entries = new Map();
        this.activeLoads = new Set();
        this.pending = new SharedSourceReads({ limit: this.limit, capacityError: () => new SourceError(
            'Maç keşif kuyruğu dolu.', 503, { retryable: true, retryAfter: 1, errorCode: 'DISCOVERY_QUEUE_FULL' }) });
    }
    get size() { return this.entries.size; }
    valid(context, source, query) {
        const proof = evidence.get(context);
        if (!proof || proof.owner !== this || context.source !== source || proof.expiresAt <= this.clock()
            || context.checkedAt > this.clock() || (query.date || null) !== proof.date
            || !sourceDependenciesValid(proof.dependencies)) return false;
        const ids = providerTeamIds(query.teamIdentities, source);
        return ['home', 'away'].every(side => teamIdentity(query[side]).qualifiers === context[side].squad
            && (ids[side] ? ids[side] === context[side].providerId : teamNamesMatch(query[side], context[side].name)));
    }
    get(source, query, provided) {
        if (provided && this.valid(provided, source, query)) return provided;
        const exact = key(source, query);
        for (const [storedKey, context] of this.entries) {
            const proof = evidence.get(context);
            if (!proof || proof.expiresAt <= this.clock() || !sourceDependenciesValid(proof.dependencies)) {
                this.entries.delete(storedKey); continue;
            }
            if ((storedKey === exact || this.valid(context, source, query)) && this.valid(context, source, query)) {
                this.entries.delete(storedKey); this.entries.set(storedKey, context); return context;
            }
        }
        return null;
    }
    remember(source, query, values, dependencies = []) {
        if (!Array.isArray(values) || !values.length || values.length > 64 || !sourceDependenciesValid(dependencies)) return null;
        const refs = values.map(raw => reference(source, raw, query));
        if (refs.some(ref => !ref || typeof ref.home !== 'string' || ref.home.length > 240
            || typeof ref.away !== 'string' || ref.away.length > 240 || typeof ref.sourceUrl !== 'string' || ref.sourceUrl.length > 2048
            || (ref.dateTimeUtc !== null && (typeof ref.dateTimeUtc !== 'string' || ref.dateTimeUtc.length > 64))
            || (ref.score !== null && (typeof ref.score !== 'string' || ref.score.length > 32 || !/^\d+ - \d+$/.test(ref.score)))
            || (ref.code !== null && !((typeof ref.code === 'number' && Number.isSafeInteger(ref.code) && ref.code > 0)
                || (typeof ref.code === 'string' && /^\d{1,20}$/.test(ref.code)))))) return null;
        if (Buffer.byteLength(JSON.stringify(refs), 'utf8') > 65536) return null;
        try {
            for (const ref of refs) {
                const link = new URL(ref.sourceUrl);
                const path = sourcePaths[source];
                const rawPath = ref.sourceUrl.slice(ref.sourceUrl.indexOf('/', ref.sourceUrl.indexOf('://') + 3));
                const original = path?.exec(rawPath);
                const parsed = path?.exec(link.pathname);
                if (link.origin !== `https://www.${source}.com` || link.username || link.password || link.port
                    || link.search || link.hash || !original || !parsed || original[2] !== ref.id || parsed[2] !== ref.id) return null;
            }
        } catch { return null; }
        const selected = providerTeamIds(query.teamIdentities, source);
        const oriented = refs.map(ref => {
            const direct = selected.home ? selected.home === ref.homeProviderId : teamNamesMatch(query.home, ref.home);
            return direct ? [ref.homeProviderId, ref.awayProviderId] : [ref.awayProviderId, ref.homeProviderId];
        });
        if (oriented.some(ids => ids[0] !== oriented[0][0] || ids[1] !== oriented[0][1])) return null;
        const context = freeze({ source, checkedAt: this.clock(),
            home: { name: query.home, squad: teamIdentity(query.home).qualifiers, providerId: oriented[0][0] },
            away: { name: query.away, squad: teamIdentity(query.away).qualifiers, providerId: oriented[0][1] }, candidates: refs });
        const expiresAt = Math.min(this.clock() + this.ttlMs, ...dependencies.map(read => read.expiresAt));
        const cacheKey = key(source, query);
        assertSourceDeadline();
        evidence.set(context, { owner: this, dependencies, expiresAt, date: query.date || null });
        this.entries.delete(cacheKey);
        while (this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value);
        this.entries.set(cacheKey, context); return context;
    }
    async read(source, query, load, { discoveryContext, signal = getSourceDeadlineSignal() } = {}) {
        assertSourceDeadline();
        if (signal?.aborted) throw signal.reason;
        const cached = this.get(source, query, discoveryContext);
        if (cached) return { candidates: candidates(cached), context: cached };
        return this.pending.read(key(source, query), ({ signal: workerSignal, transportId }) => {
            if (this.activeLoads.size >= this.limit) throw new SourceError('Maç keşif kuyruğu dolu.', 503,
                { retryable: true, retryAfter: 1, errorCode: 'DISCOVERY_QUEUE_FULL' });
            const lease = { started: false };
            this.activeLoads.add(lease);
            return withIndependentSourceDeadline(async () => {
                lease.started = true;
                try {
                    const result = await withSourceDependencies(load);
                    assertSourceDeadline();
                    if (workerSignal.aborted) throw workerSignal.reason;
                    if (!Array.isArray(result.value)) throw new SourceError('Maç keşif veri yapısı geçersiz.');
                    const context = this.remember(source, query, result.value, result.dependencies);
                    return { candidates: context ? candidates(context) : result.value, context };
                } finally { this.activeLoads.delete(lease); }
            }, { signal: workerSignal, transportId }).finally(() => {
                if (!lease.started) this.activeLoads.delete(lease);
            });
        },
        { signal, onJoin: transportId => logDiscoveryJoin(source, transportId) });
    }
    candidates(context, source, query) {
        return this.valid(context, source, query) ? candidates(context) : null;
    }
}
export function getSharedDiscoveryCache(store) {
    if (!store || typeof store !== 'object') return new DiscoveryContextCache();
    if (!shared.has(store)) shared.set(store, new DiscoveryContextCache());
    return shared.get(store);
}
