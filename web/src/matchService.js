import { NesineService } from './nesineService.js';
import { HistoricalOddsSourceResolver } from './HistoricalOddsSourceResolver.js';
import { SourceError } from './sourceHttp.js';

export function normalizeResponse(result) {
    const formattedMarkets = Object.values(result.markets || {}).flatMap(group => Object.entries(group)
        .filter(([, odds]) => Object.keys(odds).length)
        .map(([category, odds]) => ({ category, odds: Object.entries(odds).map(([name, value]) => ({ name, value })) })));
    return {
        ...result, success: true, hasOdds: formattedMarkets.length > 0,
        status: formattedMarkets.length ? 'FOUND' : 'ODDS_NOT_FOUND', formattedMarkets,
        matchName: result.match.name, matchDate: result.match.date, matchTime: result.match.time,
        matchCode: result.match.code, sourceUrl: result.match.sourceUrl, score: result.match.score,
        historicalMessage: formattedMarkets.length ? null : `${[result.match.name, result.match.date, result.match.score ? `Skor: ${result.match.score}` : null].filter(Boolean).join(' · ')}: ${result.dataSource} kaynağında doğrulanmış Nesine oranı bulunamadı.`
    };
}

export class MatchService {
    constructor({ nesine = new NesineService(), historical = new HistoricalOddsSourceResolver() } = {}) {
        this.nesine = nesine;
        this.historical = historical;
    }

    async lookup(query, mode = 'auto') {
        const warnings = [];
        if (!query.date && mode !== 'historical') {
            try {
                const current = await this.nesine.current(query);
                if (current) return normalizeResponse(current);
            } catch (error) {
                if (mode === 'current' || query.code) throw error;
                warnings.push(`Güncel Nesine kontrolü başarısız: ${error.message}`);
            }
            if (mode === 'current' || query.code) throw new SourceError('Güncel maç bulunamadı.', 404);
        }
        const recent = query.date ? null : await this.nesine.recent(query.home, query.away);
        const result = await this.historical.resolveHistoricalOdds({ ...query, date: query.date || recent?.date });
        if (!result) throw new SourceError(`${query.source}: istenen geçmiş maç bulunamadı.`, 404);
        return normalizeResponse({ ...result, isHistorical: true, warnings });
    }
}

export function validateQuery(query, { pairRequired = false } = {}) {
    for (const key of ['home', 'away', 'code', 'date', 'source', 'matchId']) {
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
    if (query.code && !/^\d+$/.test(query.code)) throw new SourceError('Geçersiz maç kodu.', 400);
    if (query.matchId != null && !/^[a-z0-9]{1,64}$/.test(query.matchId)) throw new SourceError('Geçersiz geçmiş maç kimliği.', 400);
    if (query.matchId && (!query.date || query.code)) throw new SourceError('Geçmiş maç kimliği tarih ile kullanılmalı; güncel maç koduyla birleştirilemez.', 400);
    if (query.date && (!/^\d{4}-\d{2}-\d{2}$/.test(query.date) || !Number.isFinite(Date.parse(query.date)) || new Date(query.date).toISOString().slice(0, 10) !== query.date)) throw new SourceError('Tarih YYYY-MM-DD biçiminde geçerli bir gün olmalıdır.', 400);
    return { home, away, code: query.code, source, date: query.date || null, matchId: query.matchId || null };
}
