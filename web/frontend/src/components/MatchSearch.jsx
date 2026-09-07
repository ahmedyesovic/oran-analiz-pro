import React, { useState, useEffect, useRef } from 'react';
import { Search, Loader2 } from 'lucide-react';

export default function MatchSearch({ onSearch, onClear, loading, selection }) {
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');
  const [source, setSource] = useState('mackolik');
  const homeInput = useRef(null);
  useEffect(() => {
    if (selection) {
      setHome(selection.home);
      setAway(selection.away);
      setSource(selection.source);
    }
  }, [selection]);

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
    if (h && !a) {
      const parsed = parseMatchInput(h);
      if (parsed) {
        h = parsed.home;
        a = parsed.away;
        setHome(h);
        setAway(a);
      }
    }
    if (!h || !a) return;
    onSearch(h, a, { source });
  };

  const handleClear = () => {
    setHome('');
    setAway('');
    onClear();
    homeInput.current?.focus();
  };

  const inputStyle = {
    width: '100%',
    padding: '0.875rem 1rem',
    background: 'var(--input-bg)',
    border: '1px solid var(--panel-border)',
    borderRadius: '0.75rem',
    color: 'var(--text-primary)',
    fontFamily: 'inherit',
    fontSize: '1rem',
    outline: 'none',
    transition: 'all 0.2s'
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
        
        <div className="match-search-field">
          <label htmlFor="home" style={labelStyle}>Ev Sahibi</label>
          <input 
            id="home"
            ref={homeInput}
            type="text" 
            placeholder="Örn: Genoa"
            value={home} 
            onChange={(e) => setHome(e.target.value)} 
            style={inputStyle}
            onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; e.target.style.boxShadow = '0 0 0 2px var(--focus-ring)'; }}
            onBlur={(e) => { e.target.style.borderColor = 'var(--panel-border)'; e.target.style.boxShadow = 'none'; }}
          />
        </div>
        
        <div className="match-search-versus" aria-hidden="true">VS</div>
        
        <div className="match-search-field">
          <label htmlFor="away" style={labelStyle}>Deplasman</label>
          <input 
            id="away"
            type="text" 
            placeholder="Örn: Como"
            value={away} 
            onChange={(e) => setAway(e.target.value)} 
            style={inputStyle}
            onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; e.target.style.boxShadow = '0 0 0 2px var(--focus-ring)'; }}
            onBlur={(e) => { e.target.style.borderColor = 'var(--panel-border)'; e.target.style.boxShadow = 'none'; }}
          />
        </div>
        
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
