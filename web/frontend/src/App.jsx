import React, { useState, useEffect } from 'react';
import MatchSearch from './components/MatchSearch';
import MatchResult from './components/MatchResult';
import HistoricalFallback from './components/HistoricalFallback';
import HistoricalMatches from './components/HistoricalMatches';
import ThemeSelector from './components/ThemeSelector';
import { createMatchRequests } from './utils/matchRequests';

const API_BASE_URL = import.meta.env.DEV ? '' : (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

function App() {
  const [{ data: matchData, loading, error }, setMatchState] = useState({ data: null, loading: false, error: null });
  const [{ data: h2h, loading: h2hLoading, error: h2hError }, setHistoryState] = useState({ data: null, loading: false, error: null });
  const [selection, setSelection] = useState(null);
  const [requests] = useState(() => createMatchRequests({
    apiBaseUrl: API_BASE_URL, onMatch: setMatchState, onHistory: setHistoryState, onSelection: setSelection
  }));
  useEffect(() => () => requests.dispose(), [requests]);

  return (
    <>
      <div className="background-blobs">
        <div className="blob blob-1"></div>
        <div className="blob blob-2"></div>
        <div className="blob blob-3"></div>
      </div>

      <main className="app-shell">
        <div className="app-toolbar"><ThemeSelector /></div>
        <header style={{ textAlign: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M2 17L12 22L22 17" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M2 12L12 17L22 12" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <h1 style={{ fontSize: '2.5rem', fontWeight: 800, letterSpacing: '-0.5px' }}>Oran Analiz Pro</h1>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>
            Güncel Nesine oranları, geçmiş karşılaşmalar ve Sahadan maç arşivi.
          </p>
        </header>

        <div className={`match-workspace${selection ? ' match-workspace--with-history' : ''}`}>
          <div className="match-main">
            <MatchSearch onSearch={(home, away, options) => requests.searchPair(home, away, options)}
              onClear={() => requests.clear()} loading={loading} selection={selection} />

            {error && (
              <div className="animate-fade-in" style={{ background: 'var(--error-bg)', border: '1px solid var(--error)', color: 'var(--error-text)', padding: '1rem 1.25rem', borderRadius: '0.75rem', textAlign: 'center', fontWeight: 500 }}>
                {error}
              </div>
            )}

            {matchData && !matchData.hasOdds && (
              <HistoricalFallback message={matchData.historicalMessage} />
            )}

            {matchData?.warnings?.map(warning => <p key={warning} role="status">{warning}</p>)}
            {matchData?.hasOdds && (
              <MatchResult key={`${matchData.dataSource}-${matchData.matchCode}-${matchData.matchDate}`} data={matchData} />
            )}
          </div>

          {selection && (
            <aside className="match-sidebar" aria-label="Geçmiş karşılaşmalar">
              <HistoricalMatches data={h2h} loading={h2hLoading} error={h2hError} selectedMatchId={selection.matchId}
                onSelectMatch={match => requests.selectMatch(match, selection.source)} />
            </aside>
          )}
        </div>
      </main>
    </>
  );
}

export default App;
