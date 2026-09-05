import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { categorizeMarket, MAIN_CATEGORIES } from './marketCategorizer.js';

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

    normalizeTeamName(value) {
        return String(value || '')
            .toLocaleLowerCase('tr-TR')
            .replace(/ı/g, 'i')
            .replace(/ğ/g, 'g')
            .replace(/ü/g, 'u')
            .replace(/ş/g, 's')
            .replace(/ö/g, 'o')
            .replace(/ç/g, 'c')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    teamNamesMatch(actual, expected) {
        const normalizedActual = this.normalizeTeamName(actual);
        const normalizedExpected = this.normalizeTeamName(expected);
        if (!normalizedActual || !normalizedExpected) return false;
        if (normalizedActual === normalizedExpected) return true;

        const actualTokens = new Set(normalizedActual.split(' ').filter(token => token.length >= 3));
        const expectedTokens = normalizedExpected.split(' ').filter(token => token.length >= 3);
        return expectedTokens.some(token => actualTokens.has(token));
    }

    matchesRequestedMatch(parsed, homeTeam, awayTeam, matchDate) {
        const expectedDate = this.canonicalDate(matchDate);
        const actualDate = this.canonicalDate(parsed?.matchDate);
        if (expectedDate && actualDate && expectedDate !== actualDate) return false;

        if (parsed?.homeTeam && parsed?.awayTeam) {
            return this.teamNamesMatch(parsed.homeTeam, homeTeam)
                && this.teamNamesMatch(parsed.awayTeam, awayTeam);
        }

        return true;
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

        const request = this.createAbortSignal(20000);
        try {
            const url = new URL('https://www.mackolik.com/perform/p0/ajax/components/competition/livescores/json');
            url.searchParams.append('sports[]', 'Soccer');
            url.searchParams.set('matchDate', canonicalMatchDate);

            this.log(`Mackolik tarih listesi sorgulanıyor: ${canonicalMatchDate}`);
            const response = await fetch(url, {
                signal: request.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Referer': 'https://www.mackolik.com/canli-sonuclar'
                }
            });

            if (!response.ok) {
                this.log(`Mackolik tarih listesi HTTP ${response.status} döndürdü.`);
                return [];
            }

            const payload = await response.json();
            const matches = Object.values(payload?.data?.matches || {});
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
            return [];
        } finally {
            request.clear();
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
        const history = this.buildHistory(searchResults, homeTeam, awayTeam);

        for (const item of searchResults.slice(0, 8)) {
            const finalIddaaUrl = this.toIddaaUrl(item.url);
            if (!finalIddaaUrl || triedUrls.has(finalIddaaUrl)) continue;
            triedUrls.add(finalIddaaUrl);

            const request = this.createAbortSignal(25000);
            try {
                this.log(`Doğrudan Mackolik sayfası deneniyor: ${finalIddaaUrl}`);
                const response = await fetch(finalIddaaUrl, {
                    signal: request.signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
                    }
                });

                if (!response.ok) continue;
                const parsed = this.parseMackolikIddaa(await response.text(), finalIddaaUrl);
                if (!parsed || !this.matchesRequestedMatch(parsed, homeTeam, awayTeam, matchDate)) continue;

                parsed.history = history;
                this.log('Mackolik oranları tarayıcısız olarak bulundu.');
                return parsed;
            } catch (error) {
                this.log(`Doğrudan Mackolik isteği başarısız: ${error.message}`);
            } finally {
                request.clear();
            }
        }

        return null;
    }

    /**
     * İki takımın geçmiş maçını bulur ve oranlarını getirir.
     */
    async scrapeHistoricalMatch(homeTeam, awayTeam, matchDate = null) {
        this.log(`Taranıyor: ${homeTeam} vs ${awayTeam} ${matchDate ? '(' + matchDate + ')' : ''}`);

        const canonicalMatchDate = this.canonicalDate(matchDate);
        const dateParts = canonicalMatchDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const searchDate = dateParts
            ? `${dateParts[3]}.${dateParts[2]}.${dateParts[1]}`
            : (matchDate || '');
        const query = `site:mackolik.com ${homeTeam} ${awayTeam} mac detay ${searchDate}`;
        const triedUrls = new Set();
        const dateResults = await this.findMackolikMatchesByDate(
            homeTeam,
            awayTeam,
            canonicalMatchDate
        );
        const dateResult = await this.tryHttpCandidates(
            dateResults,
            homeTeam,
            awayTeam,
            canonicalMatchDate,
            triedUrls
        );
        if (dateResult) return dateResult;

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
            return null;
        } finally {
            if (page) await page.close();
        }
    }

    detectMarketProvider(el, $) {
        let provider = null;
        $(el).find('.widget-iddaa-markets__link').each((_, a) => {
            const mobileHref = $(a).attr('data-mobile-href') || $(a).attr('href') || '';
            const lower = mobileHref.toLowerCase();
            if (lower.includes('nesine')) {
                provider = 'nesine';
                return false;
            }
            if (lower.includes('oley')) {
                provider = 'oley';
                return false;
            }
        });

        if (!provider) {
            const marketNo = $(el).attr('data-market-no') || '';
            const marketId = $(el).attr('data-market-id') || '';
            if (marketNo && marketNo !== marketId && marketNo.length <= 5) {
                provider = 'nesine';
            }
        }

        return provider;
    }

    parseMackolikIddaa(html, matchUrl = '') {
        const $ = cheerio.load(html);
        const oddsData = {};
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
            $(el).find('.widget-iddaa-markets__option').each((j, out) => {
                const name = $(out).find('.widget-iddaa-markets__label').text().trim();
                const odd = $(out).find('.widget-iddaa-markets__value').text().trim();
                
                // "-" olan veya boş olan oranları atla
                if (name && odd && odd !== '-') {
                    oddsData[category][marketName][name] = odd;
                    optionCount++;
                }
            });

            if (optionCount > 0) {
                nesineMarketCount++;
            }
        });

        // Eğer hiçbir Nesine oranı bulunamadıysa null dön
        if (nesineMarketCount === 0 || Object.keys(oddsData).length === 0) {
            this.log('Mackolik İddaa sayfasında doğrulanmış Nesine oranı bulunamadı.');
            return null;
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
        $('.widget-iddaa-markets__link').each((_, a) => {
            const href = $(a).attr('data-mobile-href') || $(a).attr('href') || '';
            const m = href.match(/utm_content=(\d+)/) || href.match(/e=(\d+)-/);
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
        if (hScore && aScore) {
            score = `${hScore} - ${aScore}`;
        }

        return {
            sourceUrl: matchUrl,
            oddsProvider: 'nesine',
            dataSource: 'mackolik',
            matchCode: matchCode,
            matchDate: matchDate,
            homeTeam: homeTeam,
            awayTeam: awayTeam,
            score: score,
            providers: [
                { 
                    name: 'nesine', 
                    odds: sortedOddsData 
                }
            ]
        };
    }
}
