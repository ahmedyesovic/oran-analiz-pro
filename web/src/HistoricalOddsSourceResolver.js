/**
 * AŞAMA 13: Geçmiş Oranlar Kaynak Çözümleyici (HistoricalOddsSourceResolver)
 * 
 * Bu sınıfın temel görevi, bir geçmiş maç için öncelikle DOĞRUDAN Nesine'den oran çekmeyi denemek,
 * başarısız olursa Mackolik üzerinden arşivlenmiş Nesine oranlarını bulmaktır.
 * 
 * KRİTİK KURAL: "nesine" dışındaki hiçbir sağlayıcıya (Oley, Bilyoner vb.) izin verilmez.
 */

import { normalize, safeString, normalizeText } from '../../utils/normalize.js';
import { MackolikScraper } from './MackolikScraper.js';

export class HistoricalOddsSourceResolver {
    constructor(options = {}) {
        this.debug = options.debug ?? true;
        this.ALLOWED_ODDS_PROVIDERS = ['nesine']; // Artık normalizeText (toUpperCase) kullanıyoruz
        this.scraper = new MackolikScraper({ debug: this.debug });
    }

    log(tag, msg) {
        if (this.debug) {
            console.log(`[${tag}]\n${msg}\n`);
        }
    }

    /**
     * Geçmiş maç için oranları çözer.
     * @param {Object} match - Aranacak geçmiş maç objesi (home, away, date vb.)
     */
    async resolveHistoricalOdds(match) {
        this.log('HistoricalResolver', 'Trying Mackolik fallback...');

        // 1. DOĞRUDAN NESİNE (Direct Nesine)
        const directNesine = await this.getHistoricalOddsFromNesine(match);

        if (directNesine && this.isProviderAllowed(directNesine.oddsProvider)) {
            return {
                dataSource: 'nesine',
                oddsProvider: directNesine.oddsProvider, // 'nesine' olmak zorunda
                odds: directNesine.odds,
                status: 'FOUND'
            };
        } else {
            this.log('DirectNesineHistorical', 'Odds: NOT FOUND');
        }

        // 2. MACKOLIK FALLBACK (Archived Nesine)
        this.log('MackolikFallback', 'STARTED');
        const mackolik = await this.getHistoricalOddsFromMackolik(match);

        if (mackolik && mackolik.providers && mackolik.providers.length > 0) {
            this.log('MackolikHistoricalMatch', 'FOUND');
            this.log('MackolikIddaa', 'FOUND');
            
            const rawProviderNames = mackolik.providers.map(p => {
                if (!p || typeof p.name !== 'string') {
                    this.log('MackolikParser', `Missing provider name.\nRaw provider:\n${JSON.stringify(p, null, 2)}`);
                    return 'UNKNOWN';
                }
                return p.name;
            });
            
            this.log('MackolikProviders', `Detected:\n${rawProviderNames.join('\n')}`);
            
            // Sadece izin verilen provider'ı (Nesine) bul
            const nesineProvider = mackolik.providers.find(provider => {
                if (!provider || !provider.name) return false;
                return this.isProviderAllowed(provider.name);
            });

            if (nesineProvider) {
                this.log('MackolikProviders', `Selected:\nNesine`);
                this.log('HistoricalOdds', 'SUCCESS');
                
                return {
                    dataSource: 'mackolik',
                    oddsProvider: 'nesine',
                    odds: nesineProvider.odds,
                    matchCode: mackolik.matchCode,
                    matchDate: mackolik.matchDate,
                    homeTeam: mackolik.homeTeam,
                    awayTeam: mackolik.awayTeam,
                    score: mackolik.score,
                    sourceUrl: mackolik.sourceUrl,
                    history: mackolik.history,
                    status: 'FOUND'
                };
            } else {
                this.log('MackolikProviders', 'Provider could not be identified.\nOdds discarded.');
            }
        } else {
            this.log('MackolikHistoricalMatch', 'NOT FOUND');
        }

        // HİÇBİR YERDE BULUNAMADI
        return {
            status: 'NOT_FOUND',
            reason: 'Nesine geçmiş oranı bulunamadı.'
        };
    }

    isProviderAllowed(rawProviderName) {
        if (!rawProviderName) {
            this.log('MackolikParser', `Provider could not be identified (undefined or null). Odds discarded.`);
            return false;
        }
        
        // HATA ÖNLEME: Internal keyword eşleşmesi için normalize kullanıyoruz (lowercase)
        const normalized = normalize(rawProviderName);
        
        return this.ALLOWED_ODDS_PROVIDERS.includes(normalized);
    }

    /**
     * 1. KAYNAK: Doğrudan Nesine API'si (Şu an mock - gerçek API bulunduğunda buraya yazılacak)
     */
    async getHistoricalOddsFromNesine(match) {
        // TODO: Gerçek Nesine geçmiş maç endpoint'i entegre edilecek.
        return null; 
    }

    /**
     * 2. KAYNAK: Mackolik API / Scraper
     */
    async getHistoricalOddsFromMackolik(match) {
        try {
            const mackolikData = await this.scraper.scrapeHistoricalMatch(match.home, match.away, match.date);
            return mackolikData;
        } catch (err) {
            this.log('MackolikScraper Error', err.message);
            return null;
        }
    }
}

