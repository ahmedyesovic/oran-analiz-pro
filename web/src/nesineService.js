import { SourceError, sourceJson, invalidateSourceCache } from './sourceHttp.js';
import { MatchFinder } from './matchFinder.js';
import { MarketParser } from './marketParser.js';
import { MackolikScraper } from './MackolikScraper.js';

export class NesineService {
    async bulletin() {
        const data = await sourceJson('https://cdnbulten.nesine.com/api/bulten/getprebultenfull', { source: 'nesine', ttl: 30000, timeout: 10000 });
        if (!Array.isArray(data?.sg?.EA)) {
            invalidateSourceCache('https://cdnbulten.nesine.com/api/bulten/getprebultenfull');
            throw new SourceError('Nesine bülten veri yapısı geçersiz.');
        }
        return data.sg.EA;
    }

    async current({ home, away, code }) {
        const events = await this.bulletin();
        const result = new MatchFinder({ debug: false }).findMatch(events, { home, away, code });
        if (!result.found || result.isReversed) return null;
        const event = result.event;
        const parsed = new MarketParser({ debug: false }).parseMatch(event, { searchedHome: home, searchedAway: away, confidence: result.confidence });
        const rawDate = String(event.D || '');
        const date = /^\d{8}$/.test(rawDate) ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}` : rawDate;
        return {
            isHistorical: false, dataSource: 'nesine', oddsProvider: 'nesine', markets: parsed?.markets || {}, confidence: result.confidence,
            match: { home: event.HN, away: event.AN, name: `${event.HN} - ${event.AN}`, code: event.C, date, time: event.DAY_TIME || event.T || null },
            details: { league: event.LIG, status: event.MS }
        };
    }

    async recent(home, away) {
        const errors = [];
        const dates = new MackolikScraper({ debug: false }).getRecentDateCandidates(7);
        const finder = new MatchFinder({ debug: false });
        for (let offset = 0; offset < dates.length; offset += 3) {
            const batch = await Promise.all(dates.slice(offset, offset + 3).map(async date => {
                try {
                    const payload = await sourceJson(`https://ls.nesine.com/api/v2/LiveScore/GetUnliveMatches?sportType=1&date=${date}`, { source: 'nesine', ttl: 300000, timeout: 8000 });
                    if (!Array.isArray(payload?.d)) {
                        invalidateSourceCache(`https://ls.nesine.com/api/v2/LiveScore/GetUnliveMatches?sportType=1&date=${date}`);
                        throw new SourceError('Geçmiş Nesine yanıtı geçersiz.');
                    }
                    const events = payload.d.map(m => ({ C: m.C, HN: m.HT, AN: m.AT, homeAliases: [m.HT, m.HTTR].filter(Boolean), awayAliases: [m.AT, m.ATTR].filter(Boolean), TYPE: 1, D: date }));
                    const found = finder.findMatch(events, { home, away });
                    return found.found && !found.isReversed ? { ...found.event, date } : null;
                } catch (error) {
                    errors.push(error);
                    console.warn(`[NesineRecent ${date}] ${error.message}`);
                    return null;
                }
            }));
            const found = batch.find(Boolean);
            if (found) return found;
        }
        if (errors.length) throw errors[0];
        return null;
    }
}
