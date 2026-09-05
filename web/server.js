import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { MatchFinder } from './src/matchFinder.js';
import { MarketParser } from './src/marketParser.js';
import { getHistoricalMatches } from '../utils/historicalMock.js';
import { HistoricalOddsSourceResolver } from './src/HistoricalOddsSourceResolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const frontendDist = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
    console.log(`[Static] Serving React Frontend from: ${frontendDist}`);
    app.use(express.static(frontendDist));
} else {
    console.log(`[Static] Serving Vanilla Frontend from: ${path.join(__dirname, 'public')}`);
    app.use(express.static(path.join(__dirname, 'public')));
}

app.use(express.json());

app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// API Endpoint to fetch and parse match odds
app.get('/api/fetch-match', async (req, res) => {
    function parseMatchInput(input) {
        if (!input) return null;
        const safeRegex = /\s*(?:-|–|—|\/|\bvs\b|\bvs\.\b|\bv\b)\s*/i;
        const parts = input.split(safeRegex);
        if (parts.length >= 2 && parts[0].trim() && parts[parts.length-1].trim()) {
            const match = input.match(safeRegex);
            if (match) {
                const idx = match.index;
                const h = input.substring(0, idx).trim();
                const a = input.substring(idx + match[0].length).trim();
                if (h && a) return { home: h, away: a };
            }
        }
        return null;
    }

    let { home, away, code } = req.query;

    if (home && !away) {
        const parsed = parseMatchInput(home);
        if (parsed) {
            home = parsed.home;
            away = parsed.away;
        }
    }

    if (!code && (!home || !away)) {
        return res.status(400).json({ error: 'Ev sahibi ve deplasman takımları zorunludur.' });
    }

    try {
        console.log(`\n[1] USER INPUT`);
        console.log(`Home: ${home}`);
        console.log(`Away: ${away}\n`);
        
        // 1. Nesine CDN'den canlı veriyi çek
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
        
        let response;
        try {
            response = await fetch('https://cdnbulten.nesine.com/api/bulten/getprebultenfull', {
                signal: controller.signal,
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Origin': 'https://www.nesine.com',
                    'Referer': 'https://www.nesine.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
        } catch (fetchErr) {
            if (fetchErr.name === 'AbortError') {
                return res.status(504).json({ error: 'Nesine sunucusu yanıt vermedi (Zaman aşımı).' });
            }
            throw fetchErr;
        } finally {
            clearTimeout(timeoutId);
        }

        if (!response.ok) {
            throw new Error(`Nesine API Hatası: ${response.status}`);
        }

        const data = await response.json();
        
        if (!data || !data.sg || !Array.isArray(data.sg.EA)) {
            throw new Error('Nesine API\'den geçersiz veri yapısı döndü.');
        }

        const allMatches = data.sg.EA;

        console.log(`[2] NESINE MATCHES LOADED`);
        console.log(`Count: ${allMatches.length}\n`);

        // 3. Maç eşleştirme motorunu çalıştır
        let result;
        if (code) {
            const event = allMatches.find(e => String(e.C) === String(code));
            if (event) {
                result = { found: true, event, confidence: 1 };
                home = event.HN;
                away = event.AN;
            } else {
                result = { found: false, reason: "Verilen kod ile eşleşen aktif maç bulunamadı." };
            }
        } else {
            const matchFinder = new MatchFinder({ debug: true });
            result = matchFinder.findMatch(allMatches, { home, away });
        }

        if (!result.found) {
            // Eşleşme yoksa, geçmiş maç araması (Historical Search) yap.
            console.log(`[3] CURRENT MATCH NOT FOUND. STARTING HISTORICAL SEARCH...`);
            let historicalMatch = null;
            let historicalDate = null;
            
            // Son 7 güne bakıyoruz
            const matchFinder = new MatchFinder({ debug: false });
            for (let i = 0; i <= 7; i++) {
                const date = new Date();
                date.setDate(date.getDate() - i);
                const dateStr = date.toISOString().split('T')[0];
                
                try {
                    const histRes = await fetch(`https://ls.nesine.com/api/v2/LiveScore/GetUnliveMatches?sportType=1&date=${dateStr}`, {
                        headers: {
                            'Accept': 'application/json, text/plain, */*',
                            'Origin': 'https://www.nesine.com',
                            'Referer': 'https://www.nesine.com/',
                            'User-Agent': 'Mozilla/5.0'
                        }
                    });
                    
                    if (histRes.ok) {
                        const histData = await histRes.json();
                        if (histData && Array.isArray(histData.d)) {
                            // MatchFinder needs HN and AN
                            const formattedHistorical = histData.d.map(m => ({
                                C: m.C,
                                HN: m.HT,
                                AN: m.AT,
                                homeAliases: [m.HT, m.HTTR].filter(Boolean),
                                awayAliases: [m.AT, m.ATTR].filter(Boolean),
                                TYPE: 1, // Treat as football
                                D: m.D
                            }));
                            const histResult = matchFinder.findMatch(formattedHistorical, { home, away });
                            if (histResult.found) {
                                historicalMatch = histResult.event;
                                historicalDate = dateStr;
                                break;
                            }
                        }
                    }
                } catch (e) {
                    console.log(`Geçmiş maç aranırken hata (${dateStr}):`, e.message);
                }
            }

            // 2. Geçmiş maç oranlarını Mackolik ve arşiv üzerinden çöz
            const targetHome = historicalMatch ? historicalMatch.HN : home;
            const targetAway = historicalMatch ? historicalMatch.AN : away;

            if (historicalMatch) {
                console.log(`\n[CurrentNesine]\nNOT FOUND\n`);
                console.log(`[HistoricalMatch]\nFOUND in Nesine (Last 7 Days)\nDate: ${historicalDate}\n`);
            } else {
                console.log(`\n[CurrentNesine]\nNOT FOUND\n`);
                console.log(`[HistoricalMatch]\nNot in Nesine 7-day unlive list. Checking Mackolik archive for ${targetHome} vs ${targetAway}...\n`);
            }
            
            // Mackolik Fallback başlat
            const resolver = new HistoricalOddsSourceResolver({ debug: true });
            const historicalResult = await resolver.resolveHistoricalOdds({
                home: targetHome,
                away: targetAway,
                date: historicalDate
            });

            if (historicalResult.status === 'FOUND') {
                // Fallback başarılı
                const formattedMarkets = [];
                if (historicalResult.odds) {
                    for (const [category, options] of Object.entries(historicalResult.odds)) {
                        for (const [marketName, odds] of Object.entries(options)) {
                            const oddArray = [];
                            for (const [name, value] of Object.entries(odds)) {
                                oddArray.push({ name, value });
                            }
                            formattedMarkets.push({
                                category: marketName,
                                odds: oddArray
                            });
                        }
                    }
                }

                const resolvedHome = historicalResult.homeTeam || targetHome;
                const resolvedAway = historicalResult.awayTeam || targetAway;
                const resolvedName = `${resolvedHome} - ${resolvedAway}`;
                const resolvedDate = historicalResult.matchDate || historicalDate || '';
                const resolvedCode = historicalResult.matchCode || (historicalMatch ? historicalMatch.C : null);

                return res.json({
                    success: true,
                    isHistorical: true,
                    hasOdds: true,
                    dataSource: historicalResult.dataSource,
                    oddsProvider: historicalResult.oddsProvider,
                    matchName: resolvedName,
                    matchCode: resolvedCode,
                    matchDate: resolvedDate,
                    score: historicalResult.score,
                    markets: historicalResult.odds || {},
                    formattedMarkets: formattedMarkets,
                    match: {
                        home: resolvedHome,
                        away: resolvedAway,
                        name: resolvedName,
                        code: resolvedCode,
                        date: resolvedDate,
                        score: historicalResult.score
                    },
                    history: historicalResult.history || null
                });
            } else {
                // Hem Nesine'de hem Mackolik'te bulunamadıysa
                if (historicalMatch) {
                    return res.json({
                        success: true,
                        isHistorical: true,
                        hasOdds: false,
                        matchName: `${historicalMatch.HN} - ${historicalMatch.AN}`,
                        matchCode: historicalMatch.C,
                        matchDate: historicalDate,
                        historicalMessage: `${historicalMatch.HN} - ${historicalMatch.AN} maçı ${historicalDate} tarihinde bulundu ancak Nesine üzerinde oran verisi artık erişilebilir değil (Mackolik geçmiş verilerinde de bulunamadı).`
                    });
                } else {
                    console.log(`[HistoricalMatch]\nNOT FOUND in both Nesine and Mackolik\n`);
                    return res.status(404).json({ error: 'Maç ne güncel bültende ne de geçmiş maç arşivinde (Nesine/Mackolik) bulunamadı.' });
                }
            }
        }

        // 4. Oranları ayrıştır (Güncel Maç)
        const matchInfo = result.event;
        
        const marketCount = matchInfo.MA ? matchInfo.MA.length : 0;
        if (marketCount === 0) {
            console.log(`[6] ODDS FETCH RESPONSE\n0 Markets`);
            return res.status(404).json({ error: `Maç bulundu (Maç Adı: ${matchInfo.HN} - ${matchInfo.AN}, Kodu: ${matchInfo.C}) fakat Nesine oran verisi (Market) alınamadı. Bahisler kapanmış olabilir.` });
        }
        
        console.log(`[6] ODDS FETCH RESPONSE\n200 OK`);

        const parser = new MarketParser({ debug: false });
        const parseResult = parser.parseMatch(matchInfo, {
            searchedHome: home,
            searchedAway: away,
            confidence: result.confidence
        });

        // Backend'deki iç içe nesneyi frontend'in beklediği dizi yapısına dönüştür
        const formattedMarkets = [];
        for (const [category, options] of Object.entries(parseResult.markets)) {
            for (const [marketName, odds] of Object.entries(options)) {
                const oddArray = [];
                for (const [name, value] of Object.entries(odds)) {
                    oddArray.push({ name, value });
                }
                formattedMarkets.push({
                    category: marketName,
                    odds: oddArray
                });
            }
        }

        const cleanMatchTitle = `${matchInfo.HN || home} - ${matchInfo.AN || away}`;

        if (formattedMarkets.length === 0) {
            return res.status(404).json({ error: `Maç bulundu (${cleanMatchTitle}, Kodu: ${matchInfo.C}) fakat talep edilen bahis türlerinde (Market) aktif oran bulunamadı.` });
        }
        
        console.log(`[7] MARKET COUNT\n${formattedMarkets.length}\n`);
        console.log(`[8] UI RENDER\nSUCCESS\n`);

        const responseData = {
            success: true,
            isHistorical: false,
            hasOdds: true,
            matchName: cleanMatchTitle,
            matchDate: matchInfo.D,
            matchTime: matchInfo.DAY_TIME,
            matchCode: matchInfo.C,
            confidence: Math.round(result.confidence * 100),
            markets: parseResult.markets,
            formattedMarkets: formattedMarkets,
            match: {
                home: matchInfo.HN || home,
                away: matchInfo.AN || away,
                name: cleanMatchTitle,
                code: matchInfo.C,
                date: matchInfo.D,
                time: matchInfo.DAY_TIME
            },
            details: {
                league: matchInfo.LIG,
                status: matchInfo.MS
            },
            history: null
        };

        res.json(responseData);

    } catch (error) {
        console.error('[API] Hata:', error.message);
        res.status(500).json({ error: 'Veri çekilirken bir hata oluştu: ' + error.message });
    }
});

// Autocomplete için Nesine'deki tüm takımları dönen endpoint
let cachedTeams = [];
let lastTeamsFetch = 0;

app.get('/api/teams', async (req, res) => {
    try {
        const now = Date.now();
        // 5 dakikada bir cache yenile
        if (cachedTeams.length > 0 && (now - lastTeamsFetch < 300000)) {
            return res.json({ success: true, teams: cachedTeams });
        }

        const response = await fetch('https://cdnbulten.nesine.com/api/bulten/getprebultenfull', {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Origin': 'https://www.nesine.com',
                'Referer': 'https://www.nesine.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
        });

        if (!response.ok) throw new Error(`Nesine API Hatası: ${response.status}`);
        const data = await response.json();
        if (!data || !data.sg || !Array.isArray(data.sg.EA)) throw new Error('Geçersiz veri');

        const teams = new Set();
        data.sg.EA.forEach(match => {
            if (match.TYPE === 1 && match.HN && match.AN) {
                teams.add(match.HN);
                teams.add(match.AN);
            }
        });

        cachedTeams = Array.from(teams).sort();
        lastTeamsFetch = now;

        res.json({ success: true, teams: cachedTeams });
    } catch (error) {
        console.error('[API] Teams Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Sunucu başlatıldı: http://localhost:${PORT}`);
    console.log(`🌐 Web arayüzüne tarayıcınızdan ulaşabilirsiniz.`);
});
