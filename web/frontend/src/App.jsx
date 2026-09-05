import React, { useState } from 'react';
import MatchSearch from './components/MatchSearch';
import MatchResult from './components/MatchResult';
import HistoricalFallback from './components/HistoricalFallback';
import HistoricalMatches from './components/HistoricalMatches';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

function App() {
  const [matchData, setMatchData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSearch = async (home, away) => {
    setLoading(true);
    setError(null);
    setMatchData(null);

    try {
      const res = await fetch(`${API_BASE_URL}/api/fetch-match?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}`);
      const data = await res.json();
      
      if (!res.ok || !data.success) {
        throw new Error(data.error || data.message || 'Maç bulunamadı.');
      }
      
      setMatchData(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="background-blobs">
        <div className="blob blob-1"></div>
        <div className="blob blob-2"></div>
        <div className="blob blob-3"></div>
      </div>

      <main style={{ maxWidth: '960px', margin: '0 auto', padding: '3rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
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
            Canlı Nesine Bülteninden yapay zeka destekli takım eşleştirme ve oran çıkarma sistemi.
          </p>
        </header>

        <MatchSearch onSearch={handleSearch} loading={loading} />

        {error && (
          <div className="animate-fade-in" style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid var(--error)', color: '#fca5a5', padding: '1rem 1.25rem', borderRadius: '0.75rem', textAlign: 'center', fontWeight: 500 }}>
            {error}
          </div>
        )}

        {matchData && matchData.isHistorical && !matchData.hasOdds && (
          <HistoricalFallback message={matchData.historicalMessage} />
        )}

        {matchData && (!matchData.isHistorical || matchData.hasOdds) && (
          <MatchResult data={matchData} />
        )}

        {matchData?.history && (
          <HistoricalMatches historyData={matchData.history} onSelectMatch={handleSearch} />
        )}
      </main>
    </>
  );
}

export default App;
