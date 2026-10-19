import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { categorizeMarket, MAIN_CATEGORIES } from './marketCategorizer.js';
import { nesineLink, sameTeam } from './sahadanParser.js';
import { SourceError, sourceJson, sourceText } from './sourceHttp.js';
import {
    normalizeTeamName as normalizeSharedTeamName,
    teamNamesMatch as sharedTeamNamesMatch
} from '../../utils/normalize.js';

puppeteer.use(StealthPlugin());

const execFileAsync = promisify(execFile);

export class MackolikScraper {
    constructor(options = {}) {
        this.debug = options.debug ?? true;
        this.browser = null;
    }

    log(msg) {
        if (this.debug) {
            console.log(`[MackolikScraper] ${msg}`);
        }
    }

    async initBrowser() {
        if (!this.browser) {
            this.log('Puppeteer browser başlatılıyor (Stealth mode)...');
            this.browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled'
                ]
            });
        }
    }

    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.log('Browser kapatıldı.');
        }
    }

    createAbortSignal(timeoutMs) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        return {
            signal: controller.signal,
            clear: () => clearTimeout(timeoutId)
        };
    }

    normalizeSearchResultUrl(rawHref) {
        if (!rawHref) return null;

        try {
            let href = String(rawHref).trim();
            if (href.startsWith('//')) href = `https:${href}`;
            if (href.startsWith('/')) href = `https://duckduckgo.com${href}`;

            if (href.includes('uddg=')) {
                const redirectUrl = new URL(href);
                href = redirectUrl.searchParams.get('uddg') || href;
            }

            const url = new URL(href);
            if (url.hostname.toLowerCase() !== 'www.mackolik.com') return null;
            if (!url.pathname.toLowerCase().startsWith('/mac/')) return null;

            url.search = '';
            url.hash = '';
            return url.toString().replace(/\/$/, '');
        } catch (_) {
            return null;
        }
    }

    extractSearchResults(html) {
        const $ = cheerio.load(html || '');
        const results = [];

        $('a.result__a, a.result__url, .result__title a').each((_, element) => {
            const url = this.normalizeSearchResultUrl($(element).attr('href'));
            if (!url || results.some(result => result.url === url)) return;

            results.push({
                url,
                title: $(element).text().trim()
            });
        });

        return results;
    }

    toIddaaUrl(matchUrl) {
        try {
            const url = new URL(matchUrl);
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts[0]?.toLowerCase() !== 'mac' || parts.length < 3) return null;

            const slug = parts[1];
            const knownTabs = new Set(['iddaa', 'istatistik', 'forum', 'karsilastirma']);
            const hasTab = knownTabs.has((parts[2] || '').toLowerCase());
            const matchId = hasTab ? parts[3] : parts[2];
            if (!slug || !matchId) return null;

            return `${url.origin}/mac/${slug}/iddaa/${matchId}`;
        } catch (_) {
            return null;
        }
    }

    canonicalDate(value) {
        const raw = String(value || '').trim();
        let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (match) return `${match[1]}-${match[2]}-${match[3]}`;

        match = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (match) return `${match[3]}-${match[2]}-${match[1]}`;

        return raw;
    }

    getRecentDateCandidates(daysBack = 7, referenceDate = new Date()) {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Europe/Istanbul',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        const parts = Object.fromEntries(
            formatter.formatToParts(referenceDate)
                .filter(part => part.type !== 'literal')
                .map(part => [part.type, part.value])
        );
        const anchorUtc = Date.UTC(
            Number(parts.year),
            Number(parts.month) - 1,
            Number(parts.day),
            12
        );

        return Array.from({ length: daysBack + 1 }, (_, index) =>
            new Date(anchorUtc - (index * 24 * 60 * 60 * 1000))
                .toISOString()
                .slice(0, 10)
        );
    }

    normalizeTeamName(value) {
        return normalizeSharedTeamName(value);
    }

    teamNamesMatch(actual, expected) {
        return sameTeam(actual, expected);
    }

    matchesRequestedMatch(parsed, homeTeam, awayTeam, matchDate) {
        const expectedDate = this.canonicalDate(matchDate);
        const actualDate = this.canonicalDate(parsed?.matchDate);
        if (!actualDate || (expectedDate && expectedDate !== actualDate)) return false;

        if (parsed?.homeTeam && parsed?.awayTeam) {
            return this.teamNamesMatch(parsed.homeTeam, homeTeam)
                && this.teamNamesMatch(parsed.awayTeam, awayTeam);
        }

        return false;
    }

    buildHistory(searchResults, homeTeam, awayTeam) {
        const history = {};

        for (const item of searchResults) {
            const dateMatch = item.title.match(/(\d{2})\.(\d{2})\.(\d{4})/);
            if (!dateMatch) continue;

            const [, day, month, year] = dateMatch;
            if (!history[year]) history[year] = {};
            if (!history[year][month]) history[year][month] = [];

            let resolvedHome = homeTeam;
            let resolvedAway = awayTeam;
            const titleParts = item.title.split(',')[0].split(' - ')[0];
            if (titleParts.includes(' vs ')) {
                const teams = titleParts.split(' vs ');
                resolvedHome = teams[0].trim();
                resolvedAway = teams[1].trim();
            }

            history[year][month].push({
                homeTeam: resolvedHome,
                awayTeam: resolvedAway,
                date: `${day}.${month}.${year}`,
                hasOdds: true
            });
        }

        return history;
    }

    async findMackolikMatchesByDate(homeTeam, awayTeam, matchDate) {
        const canonicalMatchDate = this.canonicalDate(matchDate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(canonicalMatchDate)) return [];

        try {
            const url = new URL('https://www.mackolik.com/perform/p0/ajax/components/competition/livescores/json');
            url.searchParams.append('sports[]', 'Soccer');
            url.searchParams.set('matchDate', canonicalMatchDate);

            this.log(`Mackolik tarih listesi sorgulanıyor: ${canonicalMatchDate}`);
            const payload = await sourceJson(url, { source: 'mackolik', ttl: 300000, timeout: 20000 });
            if (!payload?.data?.matches || typeof payload.data.matches !== 'object') {
                throw new SourceError('mackolik: tarih listesi yanıtı geçersiz.');
            }
            const matches = Object.values(payload.data.matches);
            if (matches.some(match => !match?.id || !match.homeTeam?.name || !match.awayTeam?.name
                || !(match.matchSlug || (match.homeTeam.slug && match.awayTeam.slug)))) {
                throw new SourceError('mackolik: tarih listesindeki maç bilgileri geçersiz.');
            }
            const [year, month, day] = canonicalMatchDate.split('-');

            const results = matches
                .filter(match => this.teamNamesMatch(match?.homeTeam?.name, homeTeam)
                    && this.teamNamesMatch(match?.awayTeam?.name, awayTeam))
                .map(match => {
                    const matchId = match?.id;
                    const matchSlug = match?.matchSlug
                        || `${match?.homeTeam?.slug || ''}-vs-${match?.awayTeam?.slug || ''}`;
                    if (!matchId || !matchSlug) return null;

                    return {
                        url: `https://www.mackolik.com/mac/${matchSlug}/iddaa/${matchId}`,
                        title: `${match.matchName || `${homeTeam} vs ${awayTeam}`}, ${day}.${month}.${year}`
                    };
                })
                .filter(Boolean);

            if (results.length > 0) {
                this.log(`Mackolik tarih listesinde ${results.length} eşleşme bulundu.`);
            } else {
                this.log('Mackolik tarih listesinde takım eşleşmesi bulunamadı.');
            }

            return results;
        } catch (error) {
            this.log(`Mackolik tarih listesi sorgusu başarısız: ${error.message}`);
            throw error;
        }
    }

    async searchMackolikWithHttp(query) {
        const endpoints = [
            'https://html.duckduckgo.com/html/',
            'https://duckduckgo.com/html/'
        ];

        for (const endpoint of endpoints) {
            const request = this.createAbortSignal(15000);
            try {
                const searchUrl = `${endpoint}?q=${encodeURIComponent(query)}`;
                this.log(`Tarayıcısız arama deneniyor: ${searchUrl}`);
                const response = await fetch(searchUrl, {
                    signal: request.signal,
                    headers: {
                        // DuckDuckGo HTML endpoint'i tam Chrome UA ile bot sayfası
                        // döndürebildiği için sade UA kullanıyoruz.
                        'User-Agent': 'Mozilla/5.0',
                        'Accept': 'text/html,application/xhtml+xml',
                        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
                    }
                });

                if (!response.ok) continue;
                const results = this.extractSearchResults(await response.text());
                if (results.length > 0) {
                    this.log(`Tarayıcısız aramada ${results.length} Mackolik sonucu bulundu.`);
                    return results;
                }
            } catch (error) {
                this.log(`Tarayıcısız arama başarısız: ${error.message}`);
            } finally {
                request.clear();
            }
        }

        // DuckDuckGo bazı sunucu ağlarında Node TLS parmak izine 202 bot
        // sayfası döndürüyor. curl aynı HTML endpoint'ini normal sonuçlarla
        // açabildiği için, shell kullanmadan güvenli bir execFile yedeği uygula.
        const curlUrl = `${endpoints[0]}?q=${encodeURIComponent(query)}`;
        try {
            this.log(`curl ile tarayıcısız arama deneniyor: ${curlUrl}`);
            const { stdout } = await execFileAsync('curl', [
                '-fsS',
                '--max-time', '20',
                '-A', 'Mozilla/5.0',
                curlUrl
            ], {
                maxBuffer: 5 * 1024 * 1024
            });

            const results = this.extractSearchResults(stdout);
            if (results.length > 0) {
                this.log(`curl aramasında ${results.length} Mackolik sonucu bulundu.`);
                return results;
            }
        } catch (error) {
            this.log(`curl araması başarısız: ${error.message}`);
        }

        return [];
    }

    async tryHttpCandidates(searchResults, homeTeam, awayTeam, matchDate, triedUrls) {
        let candidateError = null;
        const sorted = [...searchResults].sort((a, b) => {
            const date = item => this.canonicalDate(item.title.match(/\d{2}\.\d{2}\.\d{4}/)?.[0]);
            return date(b).localeCompare(date(a));
        });
        for (const item of sorted.slice(0, 8)) {
            const finalIddaaUrl = this.toIddaaUrl(item.url);
            if (!finalIddaaUrl || triedUrls.has(finalIddaaUrl)) continue;
            triedUrls.add(finalIddaaUrl);

            const request = this.createAbortSignal(25000);
            try {
                this.log(`Doğrudan Mackolik sayfası deneniyor: ${finalIddaaUrl}`);
                const html = await sourceText(finalIddaaUrl, { source: 'mackolik', ttl: 300000 });
                const parsed = this.parseMackolikIddaa(html, finalIddaaUrl);
                if (!parsed || !this.matchesRequestedMatch(parsed, homeTeam, awayTeam, matchDate)) continue;
                if (!parsed.score) continue;
                this.log('Mackolik oranları tarayıcısız olarak bulundu.');
                return parsed;
            } catch (error) {
                this.log(`Doğrudan Mackolik isteği başarısız: ${error.message}`);
                if (error.upstreamStatus === 429) throw error;
                candidateError = error;
            } finally {
                request.clear();
            }
        }

        if (candidateError) throw candidateError;
        return null;
    }

    /**
     * İki takımın geçmiş maçını bulur ve oranlarını getirir.
     */
    async scrapeHistoricalMatch(homeTeam, awayTeam, matchDate = null, matchId = null) {
        this.log(`Taranıyor: ${homeTeam} vs ${awayTeam} ${matchDate ? '(' + matchDate + ')' : ''}`);

        // H2H selection already supplies the stable provider ID. Open that page
        // directly instead of rediscovering an old match through search engines.
        if (matchId) {
            if (!/^[a-z0-9]{1,64}$/.test(matchId) || !matchDate) throw new SourceError('Geçersiz geçmiş maç seçimi.', 400);
            const slug = `${this.normalizeTeamName(homeTeam)} vs ${this.normalizeTeamName(awayTeam)}`.replaceAll(' ', '-');
            const url = `https://www.mackolik.com/mac/${slug}/iddaa/${matchId}`;
            const html = await sourceText(url, { source: 'mackolik', ttl: 300000 });
            const parsed = this.parseMackolikIddaa(html, url);
            if (parsed.matchId !== matchId || !this.matchesRequestedMatch(parsed, homeTeam, awayTeam, matchDate) || !parsed.score) {
                throw new SourceError('Seçilen Mackolik maçının kimlik, takım, tarih veya sonuç bilgisi doğrulanamadı.');
            }
            this.log(`Seçilen maç doğrudan kimliğiyle doğrulandı: ${matchId}`);
            return parsed;
        }

        const canonicalMatchDate = this.canonicalDate(matchDate);
        const dateParts = canonicalMatchDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const searchDate = dateParts
            ? `${dateParts[3]}.${dateParts[2]}.${dateParts[1]}`
            : (matchDate || '');
        const query = `site:mackolik.com ${homeTeam} ${awayTeam} mac detay ${searchDate}`;
        const triedUrls = new Set();
        const dateCandidates = dateParts
            ? [canonicalMatchDate]
            : this.getRecentDateCandidates(7);

        // Tarih Nesine'den çözülemese bile Mackolik günlük listelerini doğrudan
        // tara. Üçlü gruplar gecikmeyi sınırlarken sağlayıcıya aşırı yük bindirmez.
        for (let offset = 0; offset < dateCandidates.length; offset += 3) {
            const dateBatch = dateCandidates.slice(offset, offset + 3);
            const batchResults = await Promise.all(
                dateBatch.map(date => this.findMackolikMatchesByDate(homeTeam, awayTeam, date))
            );

            for (let index = 0; index < batchResults.length; index++) {
                const dateResult = await this.tryHttpCandidates(
                    batchResults[index],
                    homeTeam,
                    awayTeam,
                    dateBatch[index],
                    triedUrls
                );
                if (dateResult) return dateResult;
            }
        }

        const httpResults = await this.searchMackolikWithHttp(query);
        const httpResult = await this.tryHttpCandidates(
            httpResults,
            homeTeam,
            awayTeam,
            matchDate,
            triedUrls
        );
        if (httpResult) return httpResult;

        let page = null;
        try {
            this.log('HTTP yolu sonuç vermedi. Puppeteer yedek yolu deneniyor.');
            await this.initBrowser();
            page = await this.browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            this.log(`Gidiliyor: ${searchUrl}`);
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

            const searchResults = this.extractSearchResults(await page.content());

            if (!searchResults || searchResults.length === 0) {
                this.log('Maç linki arama sonuçlarında bulunamadı.');
                return null;
            }

            const browserHttpResult = await this.tryHttpCandidates(
                searchResults,
                homeTeam,
                awayTeam,
                matchDate,
                triedUrls
            );
            if (browserHttpResult) return browserHttpResult;

            const history = this.buildHistory(searchResults, homeTeam, awayTeam);
            for (const item of searchResults.slice(0, 5)) {
                const finalIddaaUrl = this.toIddaaUrl(item.url);
                if (!finalIddaaUrl) continue;

                this.log(`Puppeteer ile iddaa sayfasına gidiliyor: ${finalIddaaUrl}`);
                await page.goto(finalIddaaUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                const parsed = this.parseMackolikIddaa(await page.content(), finalIddaaUrl);
                if (!parsed || !this.matchesRequestedMatch(parsed, homeTeam, awayTeam, matchDate)) continue;

                parsed.history = history;
                return parsed;
            }

            return null;

        } catch (error) {
            this.log(`Hata oluştu: ${error.message}`);
            throw error instanceof SourceError ? error : new SourceError(`mackolik: geçmiş maç sorgusu tamamlanamadı: ${error.message}`);
        } finally {
            if (page) await page.close();
            await this.closeBrowser();
        }
    }

    detectMarketProvider(el, $) {
        return $(el).find('a').toArray().some(a =>
            nesineLink($(a).attr('data-mobile-href')) || nesineLink($(a).attr('href'))
        ) ? 'nesine' : null;
    }

    parseMackolikIddaa(html, matchUrl = '') {
        const $ = cheerio.load(html);
        const oddsData = {};
        const providerEvidence = [];
        let nesineMarketCount = 0;
        
        $('.widget-iddaa-markets__market-item').each((i, el) => {
            const provider = this.detectMarketProvider(el, $);
            
            // SADECE doğrulanmış Nesine sağlayıcısına ait marketleri kabul et
            if (provider !== 'nesine') {
                return;
            }

            const marketName = $(el).find('.widget-iddaa-markets__header-text').text().trim();
            if (!marketName) return;

            const category = categorizeMarket(marketName);
            if (!oddsData[category]) {
                oddsData[category] = {};
            }
            if (!oddsData[category][marketName]) {
                oddsData[category][marketName] = {};
            }

            let optionCount = 0;
            const lists = $(el).find('.widget-iddaa-markets__option-list').toArray();
            const verifiedLists = lists.length ? lists.filter(list => this.detectMarketProvider(list, $) === 'nesine') : [el];
            $(verifiedLists).find('.widget-iddaa-markets__option').each((j, out) => {
                const name = $(out).find('.widget-iddaa-markets__label').text().trim();
                const odd = $(out).find('.widget-iddaa-markets__value').text().trim();
                
                // "-" olan veya boş olan oranları atla
                const value = Number(odd.replace(',', '.'));
                if (name && Number.isFinite(value) && value > 1) {
                    oddsData[category][marketName][name] = value.toFixed(2);
                    optionCount++;
                }
            });

            if (optionCount > 0) {
                nesineMarketCount++;
                $(verifiedLists).find('a').each((_, a) => {
                    const link = $(a).attr('data-mobile-href') || $(a).attr('href');
                    if (nesineLink(link) && !providerEvidence.length) providerEvidence.push({ url: link });
                });
            } else {
                delete oddsData[category][marketName];
            }
        });

        // Keep verified match details even when there are no Nesine odds.
        if (nesineMarketCount === 0 || Object.keys(oddsData).length === 0) {
            this.log('Mackolik İddaa sayfasında doğrulanmış Nesine oranı bulunamadı.');
        }

        // 8 Ana kategori sırasına göre sıralı nesne oluştur
        const sortedOddsData = {};
        for (const cat of MAIN_CATEGORIES) {
            if (oddsData[cat] && Object.keys(oddsData[cat]).length > 0) {
                sortedOddsData[cat] = oddsData[cat];
            }
        }
        for (const [cat, markets] of Object.entries(oddsData)) {
            if (!sortedOddsData[cat] && Object.keys(markets).length > 0) {
                sortedOddsData[cat] = markets;
            }
        }

        this.log(`Oranlar başarıyla ayrıştırıldı. Doğrulanan Nesine market sayısı: ${nesineMarketCount}, Kategori sayısı: ${Object.keys(sortedOddsData).length}`);
        
        // Maç kodunu ve tarihini sayfadan çek
        let matchCode = null;
        $('.widget-iddaa-markets__market-item a').each((_, a) => {
            const href = $(a).attr('data-mobile-href') || $(a).attr('href') || '';
            if (!nesineLink(href)) return;
            let decoded = href;
            try { decoded = decodeURIComponent(href); } catch { /* keep original URL */ }
            const m = decoded.match(/utm_content=(\d+)/) || decoded.match(/e=(\d+)-/) || decoded.match(/code=(\d+)/);
            if (m) {
                matchCode = parseInt(m[1], 10);
                return false;
            }
        });

        let matchDate = null;
        let homeTeam = null;
        let awayTeam = null;
        const titleText = $('title').text() || '';
        const dateMatch = titleText.match(/(\d{2}\.\d{2}\.\d{4})/);
        if (dateMatch) {
            matchDate = dateMatch[1];
        }

        const mainTitle = titleText.split(',')[0].trim();
        if (mainTitle.includes(' vs ')) {
            const parts = mainTitle.split(' vs ');
            homeTeam = parts[0].trim();
            awayTeam = parts[1].trim();
        } else if (mainTitle.includes(' - ')) {
            const parts = mainTitle.split(' - ');
            homeTeam = parts[0].trim();
            awayTeam = parts[1].trim();
        }

        let score = null;
        const hScore = $('.p0c-soccer-match-details-header__score-home').text().trim();
        const aScore = $('.p0c-soccer-match-details-header__score-away').text().trim();
        if (/^\d+$/.test(hScore) && /^\d+$/.test(aScore)) {
            score = `${hScore} - ${aScore}`;
        }

        const canonicalUrl = this.normalizeSearchResultUrl($('link[rel="canonical"]').attr('href'));
        const canonicalIddaaUrl = canonicalUrl ? this.toIddaaUrl(canonicalUrl) : null;
        const matchId = canonicalIddaaUrl ? new URL(canonicalIddaaUrl).pathname.split('/').pop() : null;

        return {
            sourceUrl: matchUrl,
            matchId,
            oddsProvider: nesineMarketCount ? 'nesine' : null,
            providerEvidence,
            dataSource: 'mackolik',
            matchCode: matchCode,
            matchDate: matchDate,
            homeTeam: homeTeam,
            awayTeam: awayTeam,
            score: score,
            providers: nesineMarketCount ? [
                { 
                    name: 'nesine', 
                    odds: sortedOddsData 
                }
            ] : []
        };
    }
}
