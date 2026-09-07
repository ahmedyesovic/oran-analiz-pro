import { MackolikScraper } from './MackolikScraper.js';
import { SahadanScraper } from './SahadanScraper.js';

export class HistoricalOddsSourceResolver {
    constructor(options = {}) {
        this.scraper = options.mackolik || new MackolikScraper({ debug: options.debug ?? false });
        this.sahadan = options.sahadan || new SahadanScraper();
    }

    async resolveHistoricalOdds({ home, away, date, source = 'mackolik', matchId = null }) {
        if (source === 'sahadan') return this.sahadan.historical(home, away, date, matchId);
        if (source !== 'mackolik') throw new Error('Geçersiz geçmiş kaynak.');
        const result = await this.scraper.scrapeHistoricalMatch(home, away, date, matchId);
        if (!result) return null;
        const provider = result.providers?.find(p => p.name === 'nesine');
        const match = {
            home: result.homeTeam, away: result.awayTeam, name: `${result.homeTeam} - ${result.awayTeam}`,
            date: this.scraper.canonicalDate(result.matchDate), time: result.matchTime || null,
            id: result.matchId, code: result.matchCode, score: result.score, sourceUrl: result.sourceUrl
        };
        return { match, dataSource: 'mackolik', oddsProvider: provider ? 'nesine' : null, markets: provider?.odds || {}, providerEvidence: result.providerEvidence || [] };
    }
}
