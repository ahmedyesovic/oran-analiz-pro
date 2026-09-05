/**
 * Nesine Maç Verisi Ayrıştırma Motoru (Market Parser)
 * Hedef pazar tanımlarına göre maç objesinden oranları süzer, doğrular ve standart JS nesnesine dönüştürür.
 */

import { TARGET_MARKETS, CATEGORIES } from './marketMap.js';

export class MarketParser {
  constructor(options = {}) {
    this.debug = options.debug ?? true;
    this.logs = [];
  }

  log(tag, message) {
    const entry = `[${tag}] ${message}`;
    this.logs.push(entry);
    if (this.debug) {
      console.log(entry);
    }
  }

  /**
   * Sayısal veya string oranı doğrular ve geçerli float string formatına dönüştürür.
   * Kilitli (0, 0.0, <= 1.0), boş veya geçersiz oranları eler.
   */
  isValidOdd(val) {
    if (val === null || val === undefined || val === '' || val === '-' || val === '—') {
      return false;
    }
    const num = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.'));
    if (isNaN(num)) return false;
    // Bahiste 1.00 veya altı oranlar kapalı veya geçersizdir
    return num > 1.0;
  }

  /**
   * Oranı standart string formatına çevirir (Örn: 2.10, 1.85)
   */
  formatOdd(val) {
    const num = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.'));
    return Number.isInteger(num) ? `${num}.00` : num.toFixed(2);
  }

  /**
   * Ham Nesine maç objesini (Event Array elemanı) standart veri nesnesine ayrıştırır.
   */
  parseMatch(matchEvent, matchedQuery = null) {
    if (!matchEvent || !Array.isArray(matchEvent.MA)) {
      this.log('MarketParser', 'Geçersiz maç objesi veya boş pazar dizisi (MA).');
      return null;
    }

    const homeTeam = matchEvent.HN || 'Bilinmeyen Ev Sahibi';
    const awayTeam = matchEvent.AN || 'Bilinmeyen Deplasman';
    const matchCode = matchEvent.C || matchEvent.NID || null;
    const eventId = matchEvent.EV || null;
    const matchDate = matchEvent.D || '';
    const matchTime = matchEvent.T || '';

    this.log('MatchFinder', `Maç bulundu: ${homeTeam} - ${awayTeam} (Kod: ${matchCode}, Tarih: ${matchDate} ${matchTime})`);

    // Standart kategori ağacı oluştur
    const resultMarkets = {};
    for (const catName of Object.values(CATEGORIES)) {
      resultMarkets[catName] = {};
    }

    const rawMarkets = matchEvent.MA;
    let foundMarketsCount = 0;

    for (const target of TARGET_MARKETS) {
      const matchedRawMarket = this.findRawMarket(rawMarkets, target);

      if (!matchedRawMarket) {
        this.log('MarketParser', `${target.name} bulunamadı`);
        continue;
      }

      const outcomeData = this.extractOutcomes(matchedRawMarket, target);

      if (outcomeData && Object.keys(outcomeData).length > 0) {
        resultMarkets[target.category][target.name] = outcomeData;
        foundMarketsCount++;
        this.log('MarketParser', `${target.name} bulundu (${Object.keys(outcomeData).length} seçenek)`);
      } else {
        this.log('MarketParser', `${target.name} bulundu ancak geçerli açık oran yok`);
      }
    }

    return {
      match: {
        code: matchCode,
        eventId: eventId,
        home: homeTeam,
        away: awayTeam,
        date: matchDate,
        time: matchTime,
        matchedQuery: matchedQuery || {
          searchedHome: homeTeam,
          searchedAway: awayTeam
        }
      },
      markets: resultMarkets,
      metadata: {
        totalMarketsFound: foundMarketsCount,
        totalMarketsRequested: TARGET_MARKETS.length,
        fetchedAt: new Date().toISOString(),
        debugLogs: this.logs
      }
    };
  }

  /**
   * Ham market listesi içinden hedef tanıma uyan pazarı bulur (MTID ve SOV eşleşmesi).
   */
  findRawMarket(rawMarkets, target) {
    const targetMtids = Array.isArray(target.mtid) ? target.mtid : [target.mtid];
    const targetSovs = target.sov !== undefined && target.sov !== null
      ? (Array.isArray(target.sov) ? target.sov : [target.sov])
      : null;

    for (const raw of rawMarkets) {
      // MTID kontrolü
      if (!targetMtids.includes(raw.MTID)) {
        continue;
      }

      // SOV (Barem / Handikap) kontrolü
      if (targetSovs !== null) {
        const rawSov = raw.SOV !== undefined && raw.SOV !== null ? raw.SOV : 0.0;
        const sovMatches = targetSovs.some(tSov => Math.abs(rawSov - tSov) < 0.01);
        if (!sovMatches) {
          continue;
        }
      }

      // Bahis durumu kontrolü: Kapalı pazar elenir (MS === 0)
      if (raw.MS !== undefined && raw.MS === 0) {
        continue;
      }

      return raw;
    }

    return null;
  }

  /**
   * Seçenekleri (OCA) ayrıştırır, geçerli isim ve oranlarla eşler.
   */
  extractOutcomes(rawMarket, target) {
    if (!Array.isArray(rawMarket.OCA) || rawMarket.OCA.length === 0) {
      return null;
    }

    const outcomes = {};

    for (const item of rawMarket.OCA) {
      if (!item || !this.isValidOdd(item.O)) {
        continue;
      }

      let label = '';

      // 1. Dinamik skor veya pazar seçeneği ismi varsa (Örn: 777 Maç Skoru "1:0", "2:1", "diğer")
      if (target.dynamicOutcomes && item.ON) {
        label = item.ON;
      } else if (target.outcomeMap && target.outcomeMap[item.N]) {
        label = target.outcomeMap[item.N];
      } else if (item.ON) {
        label = item.ON;
      } else {
        label = `Seçenek ${item.N}`;
      }

      // Tekrar eden aynı etiketi önle
      if (!outcomes[label]) {
        outcomes[label] = this.formatOdd(item.O);
      }
    }

    return Object.keys(outcomes).length > 0 ? outcomes : null;
  }
}
