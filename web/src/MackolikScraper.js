import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import { categorizeMarket, MAIN_CATEGORIES } from './marketCategorizer.js';

puppeteer.use(StealthPlugin());

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

    /**
     * İki takımın geçmiş maçını bulur ve oranlarını getirir.
     */
    async scrapeHistoricalMatch(homeTeam, awayTeam, year = null) {
        this.log(`Taranıyor: ${homeTeam} vs ${awayTeam} ${year ? '(' + year + ')' : ''}`);
        
        await this.initBrowser();
        const page = await this.browser.newPage();
        
        // Rastgele User-Agent ataması
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        try {
            // Mackolik araması veya DuckDuckGo üzerinden maç URL'sini bulalım
            const query = `site:mackolik.com ${homeTeam} ${awayTeam} mac detay`;
            const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            this.log(`Gidiliyor: ${searchUrl}`);
            
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            
            // Sonuçlardan Mackolik maç linklerini bul
            const searchResults = await page.evaluate(() => {
                const results = [];
                const links = Array.from(document.querySelectorAll('a.result__a, a.result__url, .result__title a'));
                for (let a of links) {
                    let href = a.getAttribute('href') || '';
                    if (href.includes('uddg=')) {
                        try {
                            href = decodeURIComponent(href.split('uddg=')[1].split('&')[0]);
                        } catch(e) {}
                    } else if (!href.startsWith('http')) {
                        const text = a.textContent.trim();
                        if (text.startsWith('www.') || text.includes('mackolik.com')) {
                            href = 'https://' + text;
                        }
                    }
                    if (href.includes('mackolik.com/mac/')) {
                        const cleanHref = href.split('?')[0].split('#')[0];
                        if (!results.some(r => r.url === cleanHref)) {
                            results.push({
                                url: cleanHref,
                                title: a.textContent.trim()
                            });
                        }
                    }
                }
                return results;
            });

            if (!searchResults || searchResults.length === 0) {
                this.log('Maç linki arama sonuçlarında bulunamadı.');
                return null;
            }

            const matchUrl = searchResults[0].url;

            // /iddaa uzantılı sayfaya git
            const iddaaUrl = matchUrl.replace(/\/istatistik\/|\/forum\/|\/karsilastirma\//, '/').replace(/\/mac\/([^\/]+)\/([a-z0-9]+)$/, '/mac/$1/iddaa/$2');
            
            // Eğer regex çalışmazsa fallback
            let finalIddaaUrl = iddaaUrl;
            if (!finalIddaaUrl.includes('/iddaa/')) {
                const parts = matchUrl.split('/');
                const id = parts.pop();
                finalIddaaUrl = parts.join('/') + '/iddaa/' + id;
            }
            
            this.log(`İddaa sayfasına gidiliyor: ${finalIddaaUrl}`);

            // Tarihçe için diğer maçları toparlayalım
            const history = {};
            for (const item of searchResults) {
                const dateMatch = item.title.match(/(\d{2})\.(\d{2})\.(\d{4})/);
                if (dateMatch) {
                    const [_, day, month, year] = dateMatch;
                    if (!history[year]) history[year] = {};
                    if (!history[year][month]) history[year][month] = [];
                    
                    let hTeam = homeTeam;
                    let aTeam = awayTeam;
                    const titleParts = item.title.split(',')[0].split(' - ')[0];
                    if (titleParts.includes(' vs ')) {
                        const split = titleParts.split(' vs ');
                        hTeam = split[0].trim();
                        aTeam = split[1].trim();
                    }
                    history[year][month].push({
                        homeTeam: hTeam,
                        awayTeam: aTeam,
                        date: `${day}.${month}.${year}`,
                        hasOdds: true
                    });
                }
            }
            
            // 1. Önce hızlı doğrudan HTTP fetch deneyelim (Mackolik SSR iddaa içeriğini içerir)
            try {
                this.log(`Hızlı doğrudan fetch deneniyor: ${finalIddaaUrl}`);
                const fastRes = await fetch(finalIddaaUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7'
                    }
                });
                if (fastRes.ok) {
                    const fastHtml = await fastRes.text();
                    if (fastHtml.includes('widget-iddaa-markets__market-item') && !fastHtml.includes('502 Bad Gateway') && !fastHtml.includes('Cloudflare')) {
                        this.log('Doğrudan fetch ile içerik başarıyla alındı (Hızlı yol).');
                        const parsed = this.parseMackolikIddaa(fastHtml, finalIddaaUrl);
                        if (parsed) {
                            parsed.history = history;
                            return parsed;
                        }
                    }
                }
            } catch (err) {
                this.log(`Hızlı fetch başarısız, Puppeteer ile devam ediliyor: ${err.message}`);
            }

            // 2. Puppeteer ile sayfayı aç
            await page.goto(finalIddaaUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            
            const html = await page.content();
            
            this.log('Sayfa içeriği ayrıştırılıyor (Real DOM Parsing)');
            const parsed = this.parseMackolikIddaa(html, finalIddaaUrl);
            if (parsed) {
                parsed.history = history;
            }
            return parsed;

        } catch (error) {
            this.log(`Hata oluştu: ${error.message}`);
            return null;
        } finally {
            await page.close();
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
