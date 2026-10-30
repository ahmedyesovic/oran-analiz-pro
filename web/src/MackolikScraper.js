import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import { categorizeMarket, MAIN_CATEGORIES } from './marketCategorizer.js';
import { nesineLink, sameTeam } from './sahadanParser.js';
import { SourceError, sourceJson, sourceText } from './sourceHttp.js';
import * as sourceHttp from './sourceHttp.js';
import { providerTeamIds } from './verifiedCache.js';
import { collectMsSets, isFullTimeMs, msLabel, msOutcome, msSnapshot } from './matchBand.js';
import { MackolikNativeDiscovery } from './MackolikNativeDiscovery.js';
import { SEARCH_PROVIDERS, SearchPageError, buildSearchUrl, shuffledSearchProviders,
    parseSearchPage, normalizeSearchResultUrl } from './searchProviders.js';
import {
    normalizeTeamName as normalizeSharedTeamName,
    teamNamesMatch as sharedTeamNamesMatch,
    teamIdentity
} from '../../utils/normalize.js';

puppeteer.use(StealthPlugin());

export class MackolikScraper {
    constructor(options = {}) {
        this.debug = options.debug ?? true;
        this.browser = null;
        this.browserTail = Promise.resolve();
        this.directory = options.directory || null;
        this.random = options.random ?? Math.random;
        this.nativeDiscovery = options.nativeDiscovery ?? new MackolikNativeDiscovery();
    }

    log(msg) {
        if (this.debug) {
            console.log(`[MackolikScraper] ${msg}`);
        }
    }

    withBrowserLock(work) {
        const signal = sourceHttp.getSourceDeadlineSignal?.();
        const start = () => {
            if (signal?.aborted) throw signal.reason;
            sourceHttp.assertSourceDeadline?.();
            return work();
        };
        const result = this.browserTail.then(start, start);
        this.browserTail = result.catch(() => {});
        return result;
    }

    verifiedSearchResults(html, status = 200, provider = 'duckduckgo') {
        try { return parseSearchPage(provider, html, status); }
        catch (error) {
            if (!(error instanceof SearchPageError)) throw error;
            throw new SourceError(`mackolik: ${error.message}`, 502, { upstreamStatus: error.upstreamStatus, cause: error });
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

    normalizeSearchResultUrl(rawHref, provider = 'duckduckgo') {
        return normalizeSearchResultUrl(rawHref, provider);
    }

    extractSearchResults(html, provider = 'duckduckgo') {
        return parseSearchPage(provider, html);
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

    matchesRequestedMatch(parsed, homeTeam, awayTeam, matchDate, teamIdentities) {
        const expectedDate = this.canonicalDate(matchDate);
        const actualDate = this.canonicalDate(parsed?.matchDate);
        if (!actualDate || (expectedDate && expectedDate !== actualDate)) return false;

        if (parsed?.homeTeam && parsed?.awayTeam) {
            const ids = providerTeamIds(teamIdentities, 'mackolik');
            const matches = (side, expected) => ids[side]
                ? parsed[`${side}TeamId`] === ids[side]
                    && teamIdentity(parsed[`${side}Team`]).qualifiers === teamIdentity(expected).qualifiers
                : this.teamNamesMatch(parsed[`${side}Team`], expected);
            return matches('home', homeTeam) && matches('away', awayTeam);
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

    async findMackolikMatchesByDate(homeTeam, awayTeam, matchDate, teamIdentities) {
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
            if (matches.some(match => !/^[a-z0-9]{1,64}$/.test(match?.id || '') || !match.homeTeam?.name || !match.awayTeam?.name
                || !(match.matchSlug || (match.homeTeam.slug && match.awayTeam.slug)))) {
                throw new SourceError('mackolik: tarih listesindeki maç bilgileri geçersiz.');
            }
            const [year, month, day] = canonicalMatchDate.split('-');

            const ids = providerTeamIds(teamIdentities, 'mackolik');
            const matchesTeam = (actual, expected, id) => id
                ? String(actual?.id) === id && teamIdentity(actual.name).qualifiers === teamIdentity(expected).qualifiers
                : this.teamNamesMatch(actual?.name, expected);
            const results = matches
                .filter(match => matchesTeam(match?.homeTeam, homeTeam, ids.home)
                    && matchesTeam(match?.awayTeam, awayTeam, ids.away))
                .map(match => {
                    const matchId = match?.id;
                    const matchSlug = match?.matchSlug
                        || `${match?.homeTeam?.slug || ''}-vs-${match?.awayTeam?.slug || ''}`;
                    if (!matchId || !matchSlug) return null;

                    return {
                        url: `https://www.mackolik.com/mac/${matchSlug}/iddaa/${matchId}`,
                        matchId,
                        homeTeamId: match.homeTeam.id || null,
                        awayTeamId: match.awayTeam.id || null,
                        homeTeamName: match.homeTeam.name,
                        awayTeamName: match.awayTeam.name,
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

    async searchMackolikWithHttp(query, provider = 'duckduckgo') {
        const searchUrl = buildSearchUrl(provider, query);
        const label = SEARCH_PROVIDERS.find(engine => engine.id === provider)?.label || provider;
        this.log(`Ücretsiz web araması: ${label}`);
        return sourceHttp.runSourceTask(searchUrl, async ({ signal }) => {
            const response = await fetch(searchUrl, {
                signal,
                redirect: 'error',
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
                }
            });
            try { sourceHttp.sourceResponseStatus(searchUrl, response.status, response.headers, { source: 'search' }); }
            catch (error) {
                try { await response.body?.cancel(); } catch { /* Preserve the provider's status. */ }
                throw error;
            }
            try { return parseSearchPage(provider, await response.text(), response.status); }
            catch (error) {
                if (!(error instanceof SearchPageError)) throw error;
                if (error.blocked) throw sourceHttp.markSearchBlocked(searchUrl, { status: response.status });
                throw new SourceError(`search: ${label} arama yanıtı doğrulanamadı.`, 502,
                    { upstreamStatus: response.status, cause: error });
            }
        }, { source: 'search', timeout: 15000, maxAttempts: 1 });
    }

    async discoverWithSearch({ query, homeTeam, awayTeam, matchDate, triedUrls, discoveryErrors, teamIdentities }) {
        // This order belongs to one lookup, including all its fallbacks. Never
        // re-shuffle or reset it when an engine is blocked or returns no match.
        const providers = shuffledSearchProviders(this.random);
        const searchResults = new Map();
        const searchErrors = [];
        const budget = { http: 0 };
        for (const provider of providers) {
            sourceHttp.assertSourceDeadline();
            let results;
            try { results = await this.searchMackolikWithHttp(query, provider.id); }
            catch (error) {
                sourceHttp.assertSourceDeadline();
                searchErrors.push(error);
                this.log(`${provider.label} araması başarısız: ${error.message}`);
                continue;
            }
            for (const item of results) {
                const url = this.toIddaaUrl(item.url);
                if (url && !searchResults.has(url)) searchResults.set(url, { ...item, url });
            }
            try {
                const result = await this.tryHttpCandidates(results, homeTeam, awayTeam, matchDate, triedUrls, teamIdentities, budget);
                if (result) return result;
            } catch (error) {
                // Discovery engines share the same archive provider: changing
                // engines cannot bypass a Mackolik archive cooldown.
                if (error.upstreamStatus === 429) throw error;
                sourceHttp.assertSourceDeadline();
                discoveryErrors.push(error);
            }
        }
        sourceHttp.assertSourceDeadline();
        if (searchResults.size) {
            try {
                const result = await this.withBrowserLock(() => this.scrapeWithBrowser({
                    homeTeam, awayTeam, matchDate, teamIdentities, discoveryErrors,
                    searchResults: [...searchResults.values()]
                }));
                if (result) return result;
            } catch (error) {
                if (error.upstreamStatus === 429) throw error;
                sourceHttp.assertSourceDeadline();
                if (!discoveryErrors.includes(error)) discoveryErrors.push(error);
            }
        }
        const providerError = discoveryErrors.find(error => error.retryAfter) || discoveryErrors[0];
        const searchError = searchErrors.find(error => error.retryAfter) || searchErrors[0];
        if (providerError && searchError) {
            // An engine cooldown does not explain a failed native request and
            // must not prevent a later native attempt through Retry-After.
            throw new SourceError(`${providerError.message} Alternatif web araması da tamamlanamadı: ${searchError.message}`, providerError.status,
                { upstreamStatus: providerError.upstreamStatus, retryAfter: providerError.retryAfter, cause: providerError });
        }
        if (providerError || searchError) throw providerError || searchError;
        return null;
    }

    async tryHttpCandidates(searchResults, homeTeam, awayTeam, matchDate, triedUrls, teamIdentities, budget = null) {
        let candidateError = null;
        const sorted = [...searchResults].sort((a, b) => {
            const date = item => this.canonicalDate(item.title.match(/\d{2}\.\d{2}\.\d{4}/)?.[0]);
            return date(b).localeCompare(date(a));
        });
        let attempted = 0;
        for (const item of sorted) {
            const finalIddaaUrl = this.toIddaaUrl(item.url);
            if (!finalIddaaUrl || triedUrls.has(finalIddaaUrl)) continue;
            if (attempted >= 8 || (budget && budget.http >= 8)) break;
            sourceHttp.assertSourceDeadline();
            triedUrls.add(finalIddaaUrl);
            attempted++;
            if (budget) budget.http++;

            const request = this.createAbortSignal(25000);
            try {
                this.log(`Doğrudan Mackolik sayfası deneniyor: ${finalIddaaUrl}`);
                const html = await sourceText(finalIddaaUrl, { source: 'mackolik', ttl: 300000 });
                const parsed = this.parseMackolikIddaa(html, finalIddaaUrl);
                const expectedMatchId = new URL(finalIddaaUrl).pathname.split('/').pop();
                if (parsed?.matchId !== expectedMatchId
                    || (item.homeTeamId && (parsed?.matchId !== item.matchId
                        || parsed.homeTeamId !== item.homeTeamId || parsed.awayTeamId !== item.awayTeamId))) {
                    sourceHttp.invalidateSourceCache?.(finalIddaaUrl);
                    throw new SourceError('mackolik: günlük liste ve arşivdeki maç/takım kimliği uyuşmuyor.');
                }
                if (item.matchDate && this.canonicalDate(parsed.matchDate) !== item.matchDate) {
                    sourceHttp.invalidateSourceCache(finalIddaaUrl);
                    throw new SourceError('mackolik: fikstür ve arşiv maç tarihi uyuşmuyor.');
                }
                if (item.score && parsed.score !== item.score) {
                    sourceHttp.invalidateSourceCache(finalIddaaUrl);
                    throw new SourceError('mackolik: fikstür ve arşiv maç sonucu uyuşmuyor.');
                }
                // The daily names were matched to this query before opening the
                // archive. Canonical match and both header IDs above bind those
                // names to the current header, including a verified name change.
                let verifiedIdentities = teamIdentities;
                if (item.homeTeamId && item.awayTeamId && item.homeTeamName && item.awayTeamName) {
                    const selected = providerTeamIds(teamIdentities, 'mackolik');
                    if (['home', 'away'].some(side => selected[side] && selected[side] !== item[`${side}TeamId`])) continue;
                    const feedMatches = ['home', 'away'].every(side => {
                        const expected = side === 'home' ? homeTeam : awayTeam;
                        return selected[side] ? teamIdentity(item[`${side}TeamName`]).qualifiers === teamIdentity(expected).qualifiers
                            : this.teamNamesMatch(item[`${side}TeamName`], expected);
                    });
                    if (!feedMatches) continue;
                    verifiedIdentities = Object.fromEntries(['home', 'away'].map(side => [side, {
                        providers: [{ source: 'mackolik', providerId: item[`${side}TeamId`] }]
                    }]));
                }
                if (!parsed || !this.matchesRequestedMatch(parsed, homeTeam, awayTeam, matchDate, verifiedIdentities)) continue;
                if (!parsed.score) throw new SourceError('mackolik: tamamlanmış maçın sonucu doğrulanamadı.');
                this.rememberTeams(parsed, item);
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
    async scrapeHistoricalMatch(homeTeam, awayTeam, matchDate = null, matchId = null, { teamIdentities } = {}) {
        this.log(`Taranıyor: ${homeTeam} vs ${awayTeam} ${matchDate ? '(' + matchDate + ')' : ''}`);

        // H2H selection already supplies the stable provider ID. Open that page
        // directly instead of rediscovering an old match through search engines.
        if (matchId) {
            if (!/^[a-z0-9]{1,64}$/.test(matchId) || !matchDate) throw new SourceError('Geçersiz geçmiş maç seçimi.', 400);
            const slug = `${this.normalizeTeamName(homeTeam)} vs ${this.normalizeTeamName(awayTeam)}`.replaceAll(' ', '-');
            const url = `https://www.mackolik.com/mac/${slug}/iddaa/${matchId}`;
            const html = await sourceText(url, { source: 'mackolik', ttl: 300000 });
            const parsed = this.parseMackolikIddaa(html, url);
            if (parsed.matchId !== matchId || !this.matchesRequestedMatch(parsed, homeTeam, awayTeam, matchDate, teamIdentities) || !parsed.score) {
                throw new SourceError('Seçilen Mackolik maçının kimlik, takım, tarih veya sonuç bilgisi doğrulanamadı.');
            }
            this.log(`Seçilen maç doğrudan kimliğiyle doğrulandı: ${matchId}`);
            this.rememberTeams(parsed);
            return parsed;
        }

        const canonicalMatchDate = this.canonicalDate(matchDate);
        const dateParts = canonicalMatchDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const searchDate = dateParts
            ? `${dateParts[3]}.${dateParts[2]}.${dateParts[1]}`
            : (matchDate || '');
        const query = `site:mackolik.com ${homeTeam} ${awayTeam} mac detay ${searchDate}`;
        const triedUrls = new Set();
        const discoveryErrors = [];
        const dateCandidates = dateParts
            ? [canonicalMatchDate]
            : this.getRecentDateCandidates(7);

        // Tarih Nesine'den çözülemese bile Mackolik günlük listelerini doğrudan
        // tara. Üçlü gruplar gecikmeyi sınırlarken sağlayıcıya aşırı yük bindirmez.
        for (let offset = 0; offset < dateCandidates.length; offset += 3) {
            const dateBatch = dateCandidates.slice(offset, offset + 3);
            const batchResults = await Promise.allSettled(
                dateBatch.map(date => this.findMackolikMatchesByDate(homeTeam, awayTeam, date, teamIdentities))
            );

            for (let index = 0; index < batchResults.length; index++) {
                if (batchResults[index].status === 'rejected') {
                    discoveryErrors.push(batchResults[index].reason);
                    continue;
                }
                try {
                    const dateResult = await this.tryHttpCandidates(
                        batchResults[index].value, homeTeam, awayTeam, dateBatch[index], triedUrls, teamIdentities
                    );
                    if (dateResult) return dateResult;
                } catch (error) { discoveryErrors.push(error); }
            }
            const limited = discoveryErrors.find(error => error.upstreamStatus === 429);
            if (limited) throw limited;
        }

        // Native pages are another discovery path, not another odds provider.
        // Give native discovery priority even after slow earlier stages, while
        // keeping at least half of the remaining deadline for web fallback.
        const nativeBudget = Math.min(30000, sourceHttp.getSourceRemainingMs() / 2);
        if (nativeBudget > 0) {
            try {
                const nativeResult = await sourceHttp.withSourceDeadline(async () => {
                    this.log('Maçkolik takım araması ve fikstüründen doğrudan keşif deneniyor.');
                    const { candidates, errors } = await this.nativeDiscovery.discover(homeTeam, awayTeam, canonicalMatchDate || null, { teamIdentities });
                    discoveryErrors.push(...errors);
                    return this.tryHttpCandidates(candidates, homeTeam, awayTeam, matchDate, triedUrls, teamIdentities);
                }, { timeoutMs: nativeBudget });
                if (nativeResult) return nativeResult;
            } catch (error) {
                if (error.upstreamStatus === 429) throw error;
                sourceHttp.assertSourceDeadline();
                discoveryErrors.push(error);
                this.log(`Maçkolik doğrudan keşif başarısız: ${error.message}`);
            }
        }

        return this.discoverWithSearch({ query, homeTeam, awayTeam, matchDate, triedUrls, discoveryErrors, teamIdentities });
    }

    async scrapeWithBrowser({ homeTeam, awayTeam, matchDate, discoveryErrors, teamIdentities, searchResults }) {
        let page = null;
        const signal = sourceHttp.getSourceDeadlineSignal?.();
        const cancel = () => {
            page?.close().catch(() => {});
            this.closeBrowser().catch(() => {});
        };
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            sourceHttp.assertSourceDeadline?.();
            this.log('Bulunan maç bağlantıları Puppeteer ile doğrulanıyor.');
            await this.initBrowser();
            sourceHttp.assertSourceDeadline?.();
            page = await this.browser.newPage();
            sourceHttp.assertSourceDeadline?.();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            const history = this.buildHistory(searchResults, homeTeam, awayTeam);
            for (const item of searchResults.slice(0, 5)) {
                sourceHttp.assertSourceDeadline();
                const finalIddaaUrl = this.toIddaaUrl(item.url);
                if (!finalIddaaUrl) continue;

                try {
                    this.log(`Puppeteer ile iddaa sayfasına gidiliyor: ${finalIddaaUrl}`);
                    const open = async ({ signal } = {}) => {
                        const cancel = () => { page.close().catch(() => {}); };
                        signal?.addEventListener('abort', cancel, { once: true });
                        try {
                            const response = await page.goto(finalIddaaUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                            sourceHttp.sourceResponseStatus(finalIddaaUrl, response?.status() || 502, response?.headers() || {}, { source: 'mackolik' });
                            return await page.content();
                        } finally { signal?.removeEventListener('abort', cancel); }
                    };
                    const html = await sourceHttp.runSourceTask(finalIddaaUrl, open, { source: 'mackolik', timeout: 25000, deduplicate: false });
                    const parsed = this.parseMackolikIddaa(html, finalIddaaUrl);
                    const expectedId = new URL(finalIddaaUrl).pathname.split('/').pop();
                    if (!parsed || parsed.matchId !== expectedId || !parsed.score
                        || !this.matchesRequestedMatch(parsed, homeTeam, awayTeam, matchDate, teamIdentities)) continue;

                    parsed.history = history;
                    this.rememberTeams(parsed);
                    return parsed;
                } catch (error) {
                    if (error.upstreamStatus === 429) throw error;
                    sourceHttp.assertSourceDeadline();
                    discoveryErrors.push(error);
                }
            }

            if (discoveryErrors.length) throw discoveryErrors[0];
            return null;

        } catch (error) {
            this.log(`Hata oluştu: ${error.message}`);
            throw error instanceof SourceError ? error : new SourceError(`mackolik: geçmiş maç sorgusu tamamlanamadı: ${error.message}`);
        } finally {
            signal?.removeEventListener('abort', cancel);
            if (page) await page.close().catch(() => {});
            await this.closeBrowser().catch(() => {});
        }
    }

    rememberTeams(parsed, dailyEvidence = {}) {
        for (const side of ['home', 'away']) {
            const providerId = parsed[`${side}TeamId`];
            if (!providerId || !this.directory) continue;
            const name = parsed[`${side}Team`];
            const previous = this.directory.lookupProvider?.('mackolik', providerId);
            const aliases = [previous?.name, dailyEvidence[`${side}TeamName`]].filter(alias => alias
                && teamIdentity(alias).qualifiers === teamIdentity(name).qualifiers);
            this.directory.observe({ source: 'mackolik', providerId, name, aliases });
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
        const msSets = [];
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
            if (isFullTimeMs(marketName)) {
                for (const list of verifiedLists) {
                    const entries = [];
                    $(list).find('.widget-iddaa-markets__option').each((_, out) => {
                        const label = msLabel($(out).find('.widget-iddaa-markets__label').text());
                        if (!label) return;
                        const valueNode = $(out).find('.widget-iddaa-markets__value');
                        const currentValue = valueNode.clone();
                        currentValue.find('del, s, [hidden], [aria-hidden="true"]').remove();
                        currentValue.find('[style]').filter((_, node) =>
                            /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test($(node).attr('style') || '')).remove();
                        const text = currentValue.text().trim();
                        const hidden = $(out).parents().addBack().add(valueNode).toArray().some(node =>
                            $(node).is('[hidden], [aria-hidden="true"]')
                            || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test($(node).attr('style') || ''));
                        // Only explicit closure counts. Missing, faded or zero odds do not.
                        const closed = $(out).attr('aria-disabled') === 'true'
                            || $(out).find('[aria-label="Kilitli"], [aria-label="Kapalı"]').length > 0;
                        entries.push({ label, outcome: msOutcome(text, { closed, hidden }) });
                    });
                    msSets.push(...collectMsSets(entries));
                }
                $(verifiedLists).find('a').each((_, a) => {
                    const link = $(a).attr('data-mobile-href') || $(a).attr('href');
                    if (nesineLink(link) && !providerEvidence.length) providerEvidence.push({ url: link });
                });
            }
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

        const headerTeam = side => {
            const link = $(`.p0c-soccer-match-details-header__team-name--${side}`).first();
            if (!link.length) return null;
            let url;
            try { url = new URL(link.attr('href'), 'https://www.mackolik.com'); } catch { throw new SourceError('mackolik: takım bağlantısı geçersiz.'); }
            const parts = url.pathname.split('/').filter(Boolean);
            const id = parts.at(-1);
            const name = link.text().trim();
            if (url.origin !== 'https://www.mackolik.com' || parts[0] !== 'takim' || !/^[a-z0-9]{1,64}$/.test(id || '') || !name) {
                throw new SourceError('mackolik: takım kimliği doğrulanamadı.');
            }
            return { id, name };
        };
        const homeIdentity = headerTeam('home');
        const awayIdentity = headerTeam('away');
        if (Boolean(homeIdentity) !== Boolean(awayIdentity)) throw new SourceError('mackolik: takım kimlikleri eksik.');
        if (homeIdentity) {
            homeTeam = homeIdentity.name;
            awayTeam = awayIdentity.name;
        }

        return {
            sourceUrl: matchUrl,
            matchId,
            oddsProvider: nesineMarketCount ? 'nesine' : null,
            providerEvidence,
            matchResultOdds: msSnapshot(msSets),
            dataSource: 'mackolik',
            matchCode: matchCode,
            matchDate: matchDate,
            homeTeam: homeTeam,
            awayTeam: awayTeam,
            homeTeamId: homeIdentity?.id || null,
            awayTeamId: awayIdentity?.id || null,
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
