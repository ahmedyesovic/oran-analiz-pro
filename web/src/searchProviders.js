import * as cheerio from 'cheerio';

export const SEARCH_PROVIDERS = Object.freeze([
    Object.freeze({ id: 'duckduckgo', label: 'DuckDuckGo' }),
    Object.freeze({ id: 'bing', label: 'Bing' }),
    Object.freeze({ id: 'brave', label: 'Brave' })
]);

const endpoints = Object.freeze({
    duckduckgo: 'https://html.duckduckgo.com/html/',
    bing: 'https://www.bing.com/search',
    brave: 'https://search.brave.com/search'
});
const matchTabs = new Set(['iddaa', 'istatistik', 'forum', 'karsilastirma']);

function requireProvider(providerId) {
    if (!Object.hasOwn(endpoints, providerId)) throw new TypeError(`Unknown search provider: ${providerId}`);
}

export class SearchPageError extends Error {
    constructor(engine, message, { blocked = false, upstreamStatus = 200 } = {}) {
        super(`${engine}: ${message}`);
        this.name = 'SearchPageError';
        this.engine = engine;
        this.blocked = blocked;
        this.upstreamStatus = upstreamStatus;
    }
}

export function buildSearchUrl(providerId, query) {
    requireProvider(providerId);
    const url = new URL(endpoints[providerId]);
    url.searchParams.set('q', query);
    return url.toString();
}

export function shuffledSearchProviders(random = Math.random) {
    const providers = [...SEARCH_PROVIDERS];
    for (let index = providers.length - 1; index > 0; index--) {
        const target = Math.floor(random() * (index + 1));
        [providers[index], providers[target]] = [providers[target], providers[index]];
    }
    return providers;
}

function safeHttpUrl(href, base) {
    const url = new URL(href, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    return url;
}

export function normalizeSearchResultUrl(rawHref, providerId = 'duckduckgo') {
    if (typeof rawHref !== 'string' || !rawHref.trim() || !Object.hasOwn(endpoints, providerId)) return null;
    try {
        let url = safeHttpUrl(rawHref.trim(), endpoints[providerId]);
        if (!url) return null;
        if (providerId === 'duckduckgo' && ['duckduckgo.com', 'html.duckduckgo.com'].includes(url.hostname) && url.pathname === '/l/') {
            const target = url.searchParams.get('uddg');
            if (!target) return null;
            url = safeHttpUrl(target);
        } else if (providerId === 'bing' && ['www.bing.com', 'bing.com'].includes(url.hostname) && url.pathname === '/ck/a') {
            const encoded = url.searchParams.get('u');
            if (!encoded || !/^a1[A-Za-z0-9_-]+={0,2}$/.test(encoded)) return null;
            url = safeHttpUrl(Buffer.from(encoded.slice(2), 'base64url').toString('utf8'));
        }
        if (!url || url.hostname !== 'www.mackolik.com') return null;
        const parts = url.pathname.replace(/\/$/, '').split('/');
        const slug = decodeURIComponent(parts[2] || '').normalize('NFC');
        if (parts[0] !== '' || parts[1] !== 'mac' || !/^[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:-[\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*$/u.test(slug)) return null;
        if (parts.length !== 4 && (parts.length !== 5 || !matchTabs.has(parts[3]))) return null;
        const matchId = parts.at(-1);
        if (!/^[a-z0-9]{1,64}$/i.test(matchId) || matchTabs.has(matchId)) return null;
        return `https://www.mackolik.com${parts.join('/')}`;
    } catch (_) {
        return null;
    }
}

function isBlockedPage($, providerId) {
    // Inspect challenge structure before result links: block pages can contain
    // old, incidental or injected links that must never become candidates.
    const selectors = {
        duckduckgo: '#challenge-form, #anomaly-form, [class*="anomaly-modal"], form[action*="anomaly.js"], script[src*="anomaly.js"]',
        bing: '#b_captcha, #bnp_container, #turing, [id^="cf-chl"], form[action*="/turing/"], iframe[src*="captcha"]',
        brave: '#captcha, #pow-captcha, .captcha-container, #challenge-form, form[action*="/challenge"], form[action*="/consent"], iframe[src*="captcha"]'
    };
    if ($(selectors[providerId]).length) return true;
    const headings = $('title, h1, h2').text();
    return /verify (?:that )?you are human|checking your browser|captcha|unusual traffic|before you continue|consent required/i.test(headings);
}

export function parseSearchPage(providerId, html, status = 200) {
    requireProvider(providerId);
    if (status !== 200) {
        throw new SearchPageError(providerId, `Search returned HTTP ${status}.`, {
            blocked: status === 202 || status === 403,
            upstreamStatus: status
        });
    }
    if (typeof html !== 'string' || !html.trim()) throw new SearchPageError(providerId, 'Search response is missing.');
    const $ = cheerio.load(html);
    if (isBlockedPage($, providerId)) throw new SearchPageError(providerId, 'Search requires verification or consent.', { blocked: true });

    const selectors = {
        duckduckgo: '.result:not(.result--ad) .result__title a.result__a, .result:not(.result--ad) a.result__a',
        bing: '#b_results li.b_algo h2 a',
        brave: '.snippet[data-type="web"] a:has(.search-snippet-title), .snippet[data-type="web"] a.search-snippet-title'
    };
    const emptySelectors = {
        duckduckgo: '.no-results, .result--no-result',
        bing: '#b_results .b_no',
        brave: '#results .no-results, #results .no-results-found'
    };
    const anchors = $(selectors[providerId]);
    if (!anchors.length && !$(emptySelectors[providerId]).length) {
        throw new SearchPageError(providerId, 'Search response markup was not recognized.');
    }
    const results = [];
    const seen = new Set();
    anchors.each((_, element) => {
        const anchor = $(element);
        if (anchor.closest('nav, footer, .b_ad, .result--ad, [data-type="ad"]').length) return;
        const url = normalizeSearchResultUrl(anchor.attr('href'), providerId);
        if (!url || seen.has(url)) return;
        seen.add(url);
        const titleElement = providerId === 'brave' && !anchor.hasClass('search-snippet-title') ? anchor.find('.search-snippet-title').first() : anchor;
        results.push({ url, title: titleElement.text().replace(/\s+/g, ' ').trim() });
    });
    return results;
}
