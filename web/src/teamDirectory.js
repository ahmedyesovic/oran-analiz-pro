import { createHash } from 'node:crypto';
import { normalizeTeamName, explicitTeamAlias, teamIdentity } from '../../utils/normalize.js';
import { getReliabilityStore } from './reliabilityStore.js';
import { ARCHIVE_VERSION, archiveKey, verifiedArchive } from './verifiedCache.js';

const NAMESPACE = 'team-directory';
const VERSION = 1;
const ID_PATTERN = /^team_[a-f0-9]{64}$/;
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const NOISE = /\b(?:ac|afc|as|bk|cfc|cf|club|fc|fk|if|jk|kv|sc|sk|sv|stade|the)\b/g;
// Raw identity acceptance uses only exact names, verified evidence and the
// shared normalizer's explicit aliases; discovery heuristics cannot establish IDs.

function displayName(value) {
    return typeof value === 'string' && value.trim() && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
}

function identity(name) {
    const { name: base, qualifiers } = teamIdentity(name);
    return { base, squad: qualifiers || 'main' };
}

function squadName(value) {
    if (value === undefined) return null;
    if (typeof value !== 'string' || !value.trim() || value.length > 64) throw new TypeError('Invalid team squad.');
    const normalized = normalizeTeamName(value);
    if (['main', 'men', 'senior', 'first'].includes(normalized)) return 'main';
    const parsed = identity(`Team ${value}`).squad;
    return parsed === 'main' ? normalized : parsed;
}

function qualifyName(name, squad) {
    if (squad === 'main' || identity(name).squad !== 'main') return name;
    const suffix = squad.split(' ').map(part => part === 'women' ? '(K)' : part === 'reserves' ? 'Res.' : part === 'b' ? '(B)' : part.toUpperCase()).join(' ');
    return `${name} ${suffix}`;
}

function baseName(name) {
    return identity(name).base.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
}


function exactName(left, right) {
    if (identity(left).squad !== identity(right).squad) return false;
    const a = baseName(left);
    const b = baseName(right);
    if (!a || !b) return false;
    if (a === b || a.replaceAll(' ', '') === b.replaceAll(' ', '')) return true;
    const leftAlias = explicitTeamAlias(left);
    const rightAlias = explicitTeamAlias(right);
    return Boolean(leftAlias && rightAlias && leftAlias.name === rightAlias.name && leftAlias.squad === rightAlias.squad);
}

// Also useful when querying provider autocomplete: the original user input is
// retained by callers, while supported spelling variants get a useful query.
export function canonicalTeamQuery(name) {
    if (!displayName(name)) return '';
    const alias = explicitTeamAlias(name);
    if (!alias) return name.trim();
    const qualifier = alias.squad;
    if (qualifier === 'main') return alias.label;
    return `${alias.label} ${qualifier === 'women' ? '(K)' : qualifier === 'reserves' ? 'Res.' : qualifier}`;
}

function appId(source, providerId) {
    return `team_${createHash('sha256').update(JSON.stringify([source, providerId])).digest('hex')}`;
}

function project(team) {
    return { id: team.id, name: team.name, squad: team.squad, ...(team.country ? { country: team.country } : {}) };
}

function editDistance(a, b) {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let index = 1; index <= a.length; index++) {
        const current = [index];
        for (let other = 1; other <= b.length; other++) {
            current[other] = Math.min(current[other - 1] + 1, previous[other] + 1, previous[other - 1] + (a[index - 1] === b[other - 1] ? 0 : 1));
        }
        previous = current;
    }
    return previous[b.length];
}

async function defaultSearchProvider(q) {
    // A lazy import avoids a store -> transport -> directory initialization cycle.
    const { sourceJson } = await import('./sourceHttp.js');
    const url = new URL('https://www.sahadan.com/api/index/home-search');
    for (const [key, value] of Object.entries({ a: 'bs', application: 'mackolik.com', language: 'tr', country: 'tr', e: 'sss', migration_status: 'perform', autocomplete: 1, search: canonicalTeamQuery(q) })) {
        url.searchParams.set(key, value);
    }
    const response = await sourceJson(url, { source: 'sahadan', ttl: 300000 });
    if (!Array.isArray(response?.data)) throw new Error('Sahadan takım arama yanıtı geçersiz.');
    return response.data.filter(team => team?.type === 1 && /^[a-z0-9]{1,64}$/.test(team.uuid || '') && displayName(team.name))
        .map(team => ({ source: 'sahadan', providerId: team.uuid, name: team.name,
            ...(displayName(team.country?.name || team.country) ? { country: team.country?.name || team.country } : {}) }));
}

export class TeamDirectory {
    constructor({ store = getReliabilityStore(), searchProvider = defaultSearchProvider } = {}) {
        this.store = store;
        this.searchProvider = searchProvider;
    }

    #validRecord(value) {
        return value && ID_PATTERN.test(value.id) && displayName(value.name) && typeof value.squad === 'string'
            && identity(value.name).squad === value.squad
            && (value.country === undefined || Boolean(displayName(value.country)))
            && Array.isArray(value.aliases) && value.aliases.every(alias => displayName(alias) && ['main', value.squad].includes(identity(alias).squad))
            && Array.isArray(value.providers) && value.providers.length === 1
            && /^[a-z][a-z0-9_-]{0,31}$/.test(value.providers[0]?.source || '')
            && typeof value.providers[0]?.providerId === 'string' && PROVIDER_ID_PATTERN.test(value.providers[0].providerId)
            && appId(value.providers[0].source, value.providers[0].providerId) === value.id;
    }

    lookupProvider(source, providerId) {
        if (Number.isSafeInteger(providerId) && providerId >= 0) providerId = String(providerId);
        if (typeof source !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(source)
            || typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) return null;
        const id = appId(source, providerId);
        const value = this.store.getRecord(NAMESPACE, id, { version: VERSION })?.value;
        return this.#validRecord(value) && value.id === id ? value : null;
    }

    #archiveEvidence() {
        const evidence = [];
        for (const record of this.store.listRecords('verified-archives')) {
            const value = record.value;
            const match = value?.match;
            const source = value?.dataSource;
            if (record.version !== ARCHIVE_VERSION || !['mackolik', 'sahadan'].includes(source) || !match
                || record.key !== archiveKey(source, match.id, match.date) || value.oddsProvider !== 'nesine') continue;
            const code = typeof match.code === 'string' ? match.code.trim()
                : Number.isSafeInteger(match.code) && match.code > 0 ? String(match.code) : '';
            if (!code || /^0+$/.test(code) || !verifiedArchive(value, { source, home: match.home, away: match.away, matchId: match.id, date: match.date })) continue;
            // Unavailable odds are valid archives, but provide no Nesine evidence
            // from which to infer that two provider team identities are the same.
            if (!Object.values(value.markets).some(group => Object.values(group).some(selections => Object.keys(selections).length))) continue;
            if (typeof match.homeProviderId !== 'string' || !PROVIDER_ID_PATTERN.test(match.homeProviderId)
                || typeof match.awayProviderId !== 'string' || !PROVIDER_ID_PATTERN.test(match.awayProviderId)) continue;
            if (!displayName(match.home) || !displayName(match.away) || match.homeProviderId === match.awayProviderId) continue;
            evidence.push({ source, match, code });
        }
        return evidence;
    }

    #catalogue() {
        const evidence = this.#archiveEvidence();
        // Validated source archives can contain teams that autocomplete never
        // observed. Supply those exact source IDs before constructing groups.
        for (const { source, match } of evidence) {
            for (const role of ['home', 'away']) {
                const providerId = match[`${role}ProviderId`];
                const name = match[role];
                const existing = this.lookupProvider(source, providerId);
                if (existing && (existing.squad !== identity(name).squad || [existing.name, ...existing.aliases].includes(name))) continue;
                try {
                    if (existing) this.observe({ source, providerId, name: existing.name, aliases: [name] });
                    else this.observe({ source, providerId, name });
                } catch {
                    // Corrupt records and conflicting squad evidence remain
                    // unusable; successful archives cannot override those IDs.
                }
            }
        }
        const raw = this.store.listRecords(NAMESPACE)
            .filter(record => record.version === VERSION && record.key === record.value?.id && this.#validRecord(record.value))
            .map(record => record.value);
        const byId = new Map(raw.map(team => [team.id, team]));
        const edges = new Map(raw.map(team => [team.id, new Set()]));
        const events = new Map();
        for (const { source, match, code } of evidence) {
            const home = byId.get(appId(source, match.homeProviderId));
            const away = byId.get(appId(source, match.awayProviderId));
            if (!home || !away || home.id === away.id || home.squad !== identity(match.home).squad || away.squad !== identity(match.away).squad) continue;
            const key = JSON.stringify([code, match.date, match.score, home.squad, away.squad]);
            const entries = events.get(key) || [];
            entries.push({ source, home, away });
            events.set(key, entries);
        }
        for (const entries of events.values()) {
            for (let left = 0; left < entries.length; left++) {
                for (let right = left + 1; right < entries.length; right++) {
                    const a = entries[left];
                    const b = entries[right];
                    if (a.source === b.source) continue;
                    for (const role of ['home', 'away']) {
                        edges.get(a[role].id).add(b[role].id);
                        edges.get(b[role].id).add(a[role].id);
                    }
                }
            }
        }
        const teams = [];
        const visited = new Set();
        const preferSource = team => team.providers[0].source === 'sahadan' ? 0 : 1;
        for (const team of raw) {
            if (visited.has(team.id)) continue;
            const pending = [team.id];
            const members = [];
            while (pending.length) {
                const id = pending.pop();
                if (visited.has(id)) continue;
                visited.add(id);
                members.push(byId.get(id));
                pending.push(...edges.get(id));
            }
            members.sort((a, b) => preferSource(a) - preferSource(b) || a.id.localeCompare(b.id));
            // Conflicting evidence mapping two identities from one source into
            // one component cannot select an authoritative provider ID safely.
            if (members.length < 2 || new Set(members.map(member => member.providers[0].source)).size !== members.length) {
                teams.push(...members);
                continue;
            }
            const canonical = members[0];
            const combined = {
                ...canonical,
                aliases: [...new Set(members.flatMap(member => [member.name, ...member.aliases]))].sort(),
                providers: members.flatMap(member => member.providers),
                ...(canonical.country || members.find(member => member.country)?.country
                    ? { country: canonical.country || members.find(member => member.country).country } : {})
            };
            teams.push(combined);
            for (const member of members) byId.set(member.id, combined);
        }
        return { teams, byId };
    }

    #teams() {
        return this.#catalogue().teams;
    }

    #matches(team, name) {
        return identity(name).squad === team.squad && [team.name, ...team.aliases].some(alias => exactName(name, qualifyName(alias, team.squad)));
    }

    observe({ source, providerId, name, aliases = [], squad, country } = {}) {
        if (Number.isSafeInteger(providerId) && providerId >= 0) providerId = String(providerId);
        name = displayName(name);
        if (typeof source !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(source) || typeof providerId !== 'string'
            || !PROVIDER_ID_PATTERN.test(providerId) || !name || !Array.isArray(aliases) || aliases.some(alias => !displayName(alias))) {
            throw new TypeError('Invalid verified team observation.');
        }
        const nameSquad = identity(name).squad;
        const observedSquad = squadName(squad) || nameSquad;
        if (nameSquad !== 'main' && nameSquad !== observedSquad) throw new TypeError('Team squad conflicts with provider name.');
        if (aliases.some(alias => ![nameSquad, observedSquad].includes(identity(alias).squad))) throw new TypeError('Team alias has a different squad.');
        const providerName = name;
        name = qualifyName(name, observedSquad);
        if (identity(name).squad !== observedSquad) throw new TypeError('Unsupported team squad.');
        const id = appId(source, providerId);
        const old = this.store.getRecord(NAMESPACE, id, { version: VERSION })?.value;
        if (old && (old.id !== id || !this.#validRecord(old) || old.squad !== observedSquad || ![old.name, ...old.aliases].some(alias => [name, ...aliases].some(candidate => exactName(qualifyName(alias, observedSquad), qualifyName(candidate, observedSquad)))))) {
            throw new TypeError('Provider team identity changed without verified evidence.');
        }
        const value = {
            id, name, squad: observedSquad,
            aliases: [...new Set([...(old?.aliases || []), ...(old ? [old.name] : []), ...(providerName !== name ? [providerName] : []), ...aliases.map(alias => alias.trim())])],
            providers: [{ source, providerId }],
            ...(displayName(country) || old?.country ? { country: displayName(country) || old.country } : {})
        };
        this.store.setRecord(NAMESPACE, id, value, { version: VERSION });
        return value;
    }

    async resolve({ id, name } = {}) {
        if (id !== undefined && id !== null) {
            if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
            const raw = this.store.getRecord(NAMESPACE, id, { version: VERSION })?.value;
            if (!this.#validRecord(raw) || raw.id !== id) return null;
            const team = { ...(this.#catalogue().byId.get(id) || raw), id };
            return name === undefined || name === null ? team : displayName(name) && this.#matches(team, name) ? team : null;
        }
        if (!displayName(name)) return null;
        const matches = this.#teams().filter(team => this.#matches(team, name));
        return matches.length === 1 ? matches[0] : null;
    }

    #suggestions(teams, q, discovered = new Set()) {
        const query = normalizeTeamName(q);
        return teams.map(team => {
            const names = [team.name, ...team.aliases].map(normalizeTeamName);
            let rank = 4;
            if (this.#matches(team, q)) rank = 0;
            else if (names.some(name => name.startsWith(query))) rank = 1;
            else if (query.length >= 5 && names.some(name => Math.abs(name.length - query.length) <= 2 && editDistance(name, query) <= 2)) rank = 2;
            else if (discovered.has(team.id) || team.providers.some(provider => discovered.has(appId(provider.source, provider.providerId)))) rank = 3;
            return { team, rank };
        }).filter(item => item.rank < 4).sort((a, b) => a.rank - b.rank || a.team.name.localeCompare(b.team.name) || a.team.id.localeCompare(b.team.id))
            .slice(0, 8).map(item => project(item.team));
    }

    async search(q) {
        if (!displayName(q) || normalizeTeamName(q).length < 2) return [];
        q = q.trim();
        const teams = this.#teams();
        const exact = teams.filter(team => this.#matches(team, q));
        if (exact.length) return exact.slice(0, 8).map(project);
        const local = this.#suggestions(teams, q);
        if (local.length) return local;
        const found = await this.searchProvider(q);
        if (!Array.isArray(found)) throw new Error('Team search response is invalid.');
        const discovered = new Set();
        for (const candidate of found) discovered.add(this.observe(candidate).id);
        return this.#suggestions(this.#teams(), q, discovered);
    }

}

let singleton;
export function getTeamDirectory() {
    const store = getReliabilityStore();
    if (!singleton || singleton.store !== store) singleton = new TeamDirectory({ store });
    return singleton;
}
