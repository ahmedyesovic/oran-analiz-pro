/**
 * Service Worker (Background Script) - Manifest V3
 * Nesine CDN bülten verisini çeker, önbelleğe alır ve popup'a hızlı veri sağlar.
 */

import { MatchFinder } from '../utils/matchFinder.js';
import { MarketParser } from '../utils/marketParser.js';
import { getHistoricalMatches } from '../utils/historicalMock.js';

// 60 saniyelik hafif bülten önbelleği
let cachedBulletin = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 60 saniye

const PRIMARY_BULLETIN_URL = 'https://cdnbulten.nesine.com/api/bulten/getprebultenfull';
const FALLBACK_BULLETIN_URL = 'https://bulten.nesine.com/api/bulten/getprebultenfull';

/**
 * Bülten verisini CDN veya yedek API'den çeker.
 */
async function fetchBulletin(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedBulletin && (now - lastFetchTime < CACHE_TTL_MS)) {
    console.log('[ServiceWorker] Bülten önbellekten alındı.');
    return cachedBulletin;
  }

  console.log('[ServiceWorker] Bülten sunucudan çekiliyor...');
  let response;

  try {
    response = await fetch(PRIMARY_BULLETIN_URL, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'no-cache'
    });
  } catch (err) {
    console.warn('[ServiceWorker] Birincil CDN bülten isteği başarısız, yedek deneniyor...', err);
    response = await fetch(FALLBACK_BULLETIN_URL, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
  }

  if (!response.ok) {
    throw new Error(`Bülten sunucusu hata döndürdü: HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data || !data.sg || !Array.isArray(data.sg.EA)) {
    throw new Error('Geçersiz bülten veri yapısı alındı.');
  }

  cachedBulletin = data.sg.EA;
  lastFetchTime = Date.now();
  console.log(`[ServiceWorker] Bülten başarıyla yüklendi (${cachedBulletin.length} etkinlik).`);
  return cachedBulletin;
}

/**
 * Mesaj dinleyicisi
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'FETCH_MATCH_ODDS') {
    handleFetchMatchOdds(message)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Asenkron yanıt için true dönülmeli
  }

  if (message.action === 'DETECT_CURRENT_TAB_MATCH') {
    handleDetectCurrentTab()
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'FETCH_TEAMS') {
    handleFetchTeams()
      .then(result => sendResponse({ success: true, teams: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

async function handleFetchTeams() {
  const events = await fetchBulletin(false);
  const teams = new Set();
  events.forEach(match => {
    if (match.TYPE === 1 && match.HN && match.AN) {
      teams.add(match.HN);
      teams.add(match.AN);
    }
  });
  return Array.from(teams).sort();
}

/**
 * Maçı bulup oranlarını çıkaran ana iş akışı
 */
async function handleFetchMatchOdds(message) {
  const { home, away, code, debug = true, forceRefresh = false } = message;

  const events = await fetchBulletin(forceRefresh);

  const matchFinder = new MatchFinder({ debug });
  const findResult = matchFinder.findMatch(events, { home, away, code });

  if (!findResult.found) {
    // 1. Önce yerel backend'e (localhost:3000) sor (Mackolik scraping ile gerçek oranları çeker)
    console.log('[ServiceWorker] Current Match NOT FOUND in Nesine. Checking local backend (Mackolik)...');
    try {
      const backendUrl = `http://localhost:3000/api/fetch-match?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}`;
      const backendRes = await fetch(backendUrl);
      if (backendRes.ok) {
        const backendData = await backendRes.json();
        if (backendData && backendData.success) {
          console.log('[ServiceWorker] Historical match found via local backend / Mackolik:', backendData.matchName);
          return {
            found: true,
            isHistorical: backendData.isHistorical || false,
            hasOdds: backendData.hasOdds || false,
            result: {
              ...backendData,
              match: backendData.match || {
                home: home,
                away: away,
                name: backendData.matchName,
                code: backendData.matchCode,
                date: backendData.matchDate
              }
            }
          };
        }
      }
    } catch (backendErr) {
      console.log('[ServiceWorker] Local backend not available or error:', backendErr.message);
    }

    // 2. Local backend yoksa veya bulamadıysa, Nesine geçmiş bültende (son 7 gün) ara:
    console.log('[ServiceWorker] Starting Nesine Unlive Historical Search...');
    let historicalMatch = null;
    let historicalDate = null;
    
    for (let i = 0; i <= 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        
        try {
            const histRes = await fetch(`https://ls.nesine.com/api/v2/LiveScore/GetUnliveMatches?sportType=1&date=${dateStr}`, {
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Origin': 'https://www.nesine.com',
                    'Referer': 'https://www.nesine.com/'
                }
            });
            
            if (histRes.ok) {
                const histData = await histRes.json();
                if (histData && Array.isArray(histData.d)) {
                    const formattedHistorical = histData.d.map(m => ({
                        C: m.C,
                        HN: m.HT,
                        AN: m.AT,
                        homeAliases: [m.HT, m.HTTR].filter(Boolean),
                        awayAliases: [m.AT, m.ATTR].filter(Boolean),
                        TYPE: 1,
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
            console.log(`[ServiceWorker] Geçmiş maç aranırken hata (${dateStr}):`, e.message);
        }
    }

    if (historicalMatch) {
      console.log(`[ServiceWorker] HISTORICAL MATCH FOUND: ${historicalMatch.C} on ${historicalDate}`);
      return {
        found: true,
        isHistorical: true,
        hasOdds: false,
        result: {
            isHistorical: true,
            hasOdds: false,
            match: {
                home: historicalMatch.HN || home,
                away: historicalMatch.AN || away,
                name: `${historicalMatch.HN || home} - ${historicalMatch.AN || away}`,
                code: historicalMatch.C,
                date: historicalDate
            },
            historicalMessage: `${historicalMatch.HN} - ${historicalMatch.AN} maçı ${historicalDate} tarihinde bulundu ancak Nesine üzerinde oran verisi artık erişilebilir değil.`
        }
      };
    }

    return {
      found: false,
      reason: findResult.reason || 'Maç güncel bültende veya geçmişte (son 7 gün) bulunamadı.',
      searched: { home, away, code }
    };
  }

  const parser = new MarketParser({ debug });
  const parsedData = parser.parseMatch(findResult.event, {
    searchedHome: home,
    searchedAway: away,
    confidence: findResult.confidence,
    matchedBy: findResult.matchedBy
  });

  // Geçmiş maç sistemi geçici olarak kapalı
  parsedData.history = null;

  return {
    found: true,
    result: parsedData
  };
}

/**
 * Aktif açık sekmede bir Nesine maçı varsa kodunu veya URL parametresini tespit eder.
 */
async function handleDetectCurrentTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) return null;

    const currentTab = tabs[0];
    if (!currentTab.url || !currentTab.url.includes('nesine.com')) {
      return null;
    }

    const url = new URL(currentTab.url);
    const code = url.searchParams.get('code');
    return {
      url: currentTab.url,
      code: code ? parseInt(code, 10) : null
    };
  } catch (err) {
    console.error('Sekme bilgisi alınamadı:', err);
    return null;
  }
}
