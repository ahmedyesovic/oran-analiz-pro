import React, { useState } from 'react';
import { Search, Loader2 } from 'lucide-react';

export default function MatchSearch({ onSearch, loading }) {
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');

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
    onSearch(h, a);
  };

  const inputStyle = {
    width: '100%',
    padding: '0.875rem 1rem',
    background: 'rgba(15, 23, 42, 0.6)',
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
    <section className="glass-panel animate-fade-in" style={{ padding: '2rem' }}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap' }}>
        
        <div style={{ flex: 1, minWidth: '200px' }}>
          <label style={labelStyle}>Ev Sahibi</label>
          <input 
            type="text" 
            placeholder="Örn: Ipswich FC" 
            value={home} 
            onChange={(e) => setHome(e.target.value)} 
            style={inputStyle}
            onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; e.target.style.boxShadow = '0 0 0 2px rgba(16,185,129,0.2)'; }}
            onBlur={(e) => { e.target.style.borderColor = 'var(--panel-border)'; e.target.style.boxShadow = 'none'; }}
          />
        </div>
        
        <div style={{ fontWeight: 700, color: 'var(--text-secondary)', paddingBottom: '1rem', fontSize: '1.25rem', opacity: 0.5 }}>VS</div>
        
        <div style={{ flex: 1, minWidth: '200px' }}>
          <label style={labelStyle}>Deplasman</label>
          <input 
            type="text" 
            placeholder="Örn: Liverpool" 
            value={away} 
            onChange={(e) => setAway(e.target.value)} 
            style={inputStyle}
            onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; e.target.style.boxShadow = '0 0 0 2px rgba(16,185,129,0.2)'; }}
            onBlur={(e) => { e.target.style.borderColor = 'var(--panel-border)'; e.target.style.boxShadow = 'none'; }}
          />
        </div>
        
        <button 
          type="submit" 
          disabled={loading || (!home.trim() && !away.trim())}
          style={{
            background: loading || (!home.trim() && !away.trim()) ? 'rgba(16,185,129,0.5)' : 'var(--accent)',
            color: 'white',
            border: 'none',
            padding: '0.875rem 2rem',
            borderRadius: '0.75rem',
            fontWeight: 600,
            fontSize: '1rem',
            cursor: loading || (!home.trim() || !away.trim()) ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
            minWidth: '160px',
            height: '50px'
          }}
        >
          {loading ? <Loader2 className="animate-spin" size={20} /> : <><Search size={20} /> Oranları Bul</>}
        </button>

      </form>
    </section>
  );
}
