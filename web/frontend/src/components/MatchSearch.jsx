import React, { useState, useEffect, useRef } from 'react';
import { Search, Loader2 } from 'lucide-react';
import TeamSearchInput from './TeamSearchInput';
import { createTeamSuggestions } from '../utils/teamSuggestions';

const emptyField = { value: '', selectedId: null, teams: [], loading: false, error: null, open: false, activeIndex: -1 };

export default function MatchSearch({ onSearch, onClear, loading, selection, apiBaseUrl = '' }) {
  const [homeState, setHomeState] = useState(emptyField);
  const [awayState, setAwayState] = useState(emptyField);
  const [homeSuggestions] = useState(() => createTeamSuggestions({ apiBaseUrl, onState: setHomeState }));
  const [awaySuggestions] = useState(() => createTeamSuggestions({ apiBaseUrl, onState: setAwayState }));
  const home = homeState.value;
  const away = awayState.value;
  const [source, setSource] = useState('mackolik');
  const homeInput = useRef(null);
  useEffect(() => {
    if (selection) {
      homeSuggestions.replace(selection.home, selection.homeTeamId);
      awaySuggestions.replace(selection.away, selection.awayTeamId);
      setSource(selection.source);
    }
  }, [selection, homeSuggestions, awaySuggestions]);
  useEffect(() => () => {
    homeSuggestions.dispose();
    awaySuggestions.dispose();
  }, [homeSuggestions, awaySuggestions]);

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

  const handleSubmit = (e) => {
    e.preventDefault();
    if (loading) return;
    let h = home.trim();
    let a = away.trim();
    let homeTeamId = homeState.selectedId;
    let awayTeamId = awayState.selectedId;
    if (h && !a) {
      const parsed = parseMatchInput(h);
      if (parsed) {
        h = parsed.home;
        a = parsed.away;
        homeSuggestions.replace(h);
        awaySuggestions.replace(a);
        homeTeamId = null;
        awayTeamId = null;
      }
    }
    if (!h || !a) return;
    homeSuggestions.dismiss();
    awaySuggestions.dismiss();
    onSearch(h, a, { source, ...(homeTeamId ? { homeTeamId } : {}), ...(awayTeamId ? { awayTeamId } : {}) });
  };

  const handleClear = () => {
    homeSuggestions.clear();
    awaySuggestions.clear();
    onClear();
    homeInput.current?.focus();
  };

  const labelStyle = {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: 500,
    color: 'var(--text-secondary)',
    marginBottom: '0.5rem'
  };

  return (
    <section className="glass-panel animate-fade-in match-search">
      <form onSubmit={handleSubmit} className="match-search-form">
        
        <TeamSearchInput id="home" label="Ev Sahibi" placeholder="Örn: Genoa"
          inputRef={homeInput} state={homeState} controller={homeSuggestions} />
        <div className="match-search-versus" aria-hidden="true">VS</div>
        <TeamSearchInput id="away" label="Deplasman" placeholder="Örn: Como"
          state={awayState} controller={awaySuggestions} />

        <div className="match-search-actions">
          <button type="submit" className="match-search-button match-search-submit"
            disabled={loading || (!home.trim() && !away.trim())} aria-busy={loading}>
            {loading ? <Loader2 className="animate-spin" size={18} aria-hidden="true" />
              : <Search className="match-search-icon" size={18} aria-hidden="true" />}
            <span aria-live="polite">{loading ? 'Aranıyor…' : 'Oranları Bul'}</span>
          </button>
          <button type="button" className="match-search-button match-search-clear" onClick={handleClear}>
            Temizle
          </button>
        </div>
        <fieldset disabled={loading} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, flexBasis: '100%', display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <legend style={labelStyle}>Geçmiş Oran Kaynağı</legend>
          {['mackolik', 'sahadan'].map(value => <label key={value} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <input type="radio" name="source" value={value} checked={source === value} onChange={() => setSource(value)} />
            {value === 'mackolik' ? 'Mackolik' : 'Sahadan'}
          </label>)}
          <small style={{ color: 'var(--text-secondary)', flexBasis: '100%' }}>Önce güncel Nesine bülteni, ardından en son tamamlanmış maç aranır.</small>
        </fieldset>
      </form>
    </section>
  );
}
