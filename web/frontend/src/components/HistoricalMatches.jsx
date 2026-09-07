import React from 'react';
import { ChevronRight, ExternalLink, History } from 'lucide-react';

function scoreParts(score) {
  return score?.match(/^(\d+)\s*-\s*(\d+)$/)?.slice(1) || ['—', '—'];
}

export default function HistoricalMatches({ data, loading, error, onSelectMatch, selectedMatchId }) {
  const matches = data?.matches || [];
  return (
    <section className="glass-panel animate-fade-in historical-matches" aria-label="Aralarındaki Maçlar">
      <h2 className="historical-matches-title">
        <History size={20} aria-hidden="true" />
        <span>Aralarındaki Maçlar</span>
        {data && <span className="historical-matches-count" aria-label={`${matches.length} karşılaşma`}>{matches.length}</span>}
      </h2>
      <p className="historical-matches-source">
        {data?.sourceUrl ? <a href={data.sourceUrl} target="_blank" rel="noopener noreferrer">
          <span>Sahadan tablosu{data.sourceMatchDate ? ` · ${data.sourceMatchDate.split('-').reverse().join('.')}` : ''}</span>
          <ExternalLink size={14} aria-hidden="true" />
        </a> : 'Kaynak: Sahadan'}
      </p>
      {loading && <p className="historical-matches-message" role="status">Aralarındaki maçlar yükleniyor…</p>}
      {error && <p className="historical-matches-message historical-matches-error" role="alert">{error}</p>}
      {!loading && !error && !matches.length && <p className="historical-matches-message">Sahadan tablosunda karşılaşma bulunmuyor.</p>}
      {!!matches.length && <p className="historical-matches-hint">Oranları görmek için bir maç seçin.</p>}
      <div className="historical-matches-list">
        {!!matches.length && <>
          <div className="historical-matches-columns" aria-hidden="true">
            <span>Karşılaşma</span><span>Maç<br />sonu</span><span>İlk<br />yarı</span>
          </div>
          <ol className="historical-matches-rows" aria-label="Sahadan Aralarındaki Maçlar">
            {matches.map(match => {
              const fullTime = scoreParts(match.score);
              const halfTime = scoreParts(match.halfTimeScore);
              const date = match.date.split('-').reverse().join('.');
              const selected = selectedMatchId === match.id;
              return <li key={match.id}>
                <button type="button" className={`historical-match${selected ? ' historical-match--selected' : ''}`}
                  onClick={() => onSelectMatch(match)} aria-pressed={selected}
                  aria-label={`${date}, ${match.home} - ${match.away}. Maç sonu: ${match.score || 'bilinmiyor'}. İlk yarı: ${match.halfTimeScore || 'bilinmiyor'}. Oranları aç.`}>
                  <span className="historical-match-meta">
                    <time dateTime={match.date}>{date}</time>
                    <span className="historical-match-indicator">
                      {selected && <span>Seçili</span>}<ChevronRight size={16} aria-hidden="true" />
                    </span>
                  </span>
                  <span className="historical-match-team">{match.home}</span>
                  <strong className="historical-match-score">{fullTime[0]}</strong>
                  <span className="historical-match-half-time">{halfTime[0]}</span>
                  <span className="historical-match-team">{match.away}</span>
                  <strong className="historical-match-score">{fullTime[1]}</strong>
                  <span className="historical-match-half-time">{halfTime[1]}</span>
                </button>
              </li>;
            })}
          </ol>
        </>}
      </div>
    </section>
  );
}
