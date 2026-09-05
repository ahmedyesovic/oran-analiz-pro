/**
 * Nesine Bülteni İçinde Maç Bulma Motoru (Match Finder) - SADE
 */

import { normalize } from '../../utils/normalize.js';

export class MatchFinder {
  constructor(options = {}) {
    this.debug = options.debug ?? true;
  }

  log(tag, msg) {
    if (this.debug) {
      console.log(`[${tag}] ${msg}`);
    }
  }

  findMatch(eventsArray, query = {}) {
    const { home, away, code } = query;

    this.log('3', `MATCH SEARCH`);
    
    if (code) {
      const codeNum = parseInt(code, 10);
      const exactByCode = eventsArray.find(e => e.C === codeNum || e.NID === codeNum);
      if (exactByCode) {
        this.log('4', `MATCH FOUND`);
        this.log('5', `MATCH ID\n${codeNum}`);
        return {
          found: true,
          event: exactByCode,
          confidence: 100,
          matchedBy: 'code'
        };
      }
    }

    if (!home || !away) {
      this.log('4', `MATCH NOT FOUND (Missing home/away)`);
      return { found: false, reason: 'Ev sahibi ve deplasman takımları belirtilmelidir.' };
    }

    // Futbol maçlarını filtrele (TYPE: 1)
    const footballMatches = eventsArray.filter(e => e.TYPE === 1 && e.HN && e.AN);
    
    const userHome = normalize(home);
    const userAway = normalize(away);

    this.log('3', `Candidate search for: ${userHome} - ${userAway}`);

    for (const match of footballMatches) {
      const matchHome = normalize(match.HN);
      const matchAway = normalize(match.AN);

      if (userHome === matchHome && userAway === matchAway) {
        this.log('3', `Candidate:\n${match.HN} - ${match.AN}`);
        this.log('4', `MATCH FOUND`);
        this.log('5', `MATCH ID\n${match.C}`);
        return {
          found: true,
          event: match,
          confidence: 100,
          matchedBy: 'teams'
        };
      }
      
      // Substring eşleşmesi (Basit - exact çalışmazsa)
      if (matchHome.includes(userHome) && matchAway.includes(userAway)) {
        this.log('3', `Candidate (Substring):\n${match.HN} - ${match.AN}`);
        this.log('4', `MATCH FOUND`);
        this.log('5', `MATCH ID\n${match.C}`);
        return {
          found: true,
          event: match,
          confidence: 90,
          matchedBy: 'teams'
        };
      }
    }

    // Ters eşleşme kontrolü
    for (const match of footballMatches) {
      const matchHome = normalize(match.HN);
      const matchAway = normalize(match.AN);

      if (userHome === matchAway && userAway === matchHome) {
        this.log('3', `Candidate (Reversed):\n${match.HN} - ${match.AN}`);
        this.log('4', `MATCH FOUND`);
        this.log('5', `MATCH ID\n${match.C}`);
        return {
          found: true,
          event: match,
          confidence: 100,
          matchedBy: 'teams',
          isReversed: true
        };
      }
    }

    this.log('4', `MATCH NOT FOUND`);
    return {
      found: false,
      reason: 'Maç bulunamadı. (Benzerlik eşiği geçilemedi, konsol loglarını kontrol edin.)'
    };
  }
}
