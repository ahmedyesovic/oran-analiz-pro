import React, { useState, useMemo } from 'react';
import { History, Filter, Calendar, ExternalLink } from 'lucide-react';

export default function HistoricalMatches({ historyData, onSelectMatch }) {
  if (!historyData || Object.keys(historyData).length === 0) {
    return null;
  }

  const [selectedYear, setSelectedYear] = useState('all');
  const [selectedMonth, setSelectedMonth] = useState('all');
  const [selectedOdds, setSelectedOdds] = useState('all');

  const years = useMemo(() => {
    return Object.keys(historyData).sort((a, b) => b - a);
  }, [historyData]);

  const availableMonths = useMemo(() => {
    const months = new Set();
    if (selectedYear === 'all') {
      years.forEach(y => {
        if (historyData[y]) Object.keys(historyData[y]).forEach(m => months.add(m));
      });
    } else if (historyData[selectedYear]) {
      Object.keys(historyData[selectedYear]).forEach(m => months.add(m));
    }
    return Array.from(months);
  }, [historyData, selectedYear, years]);

  const filteredMatches = useMemo(() => {
    const result = [];
    const targetYears = selectedYear === 'all' ? years : [selectedYear];

    targetYears.forEach(y => {
      const yearObj = historyData[y];
      if (!yearObj) return;

      const targetMonths = selectedMonth === 'all' ? Object.keys(yearObj) : [selectedMonth];
      targetMonths.forEach(m => {
        const matchesInMonth = yearObj[m];
        if (!Array.isArray(matchesInMonth)) return;

        matchesInMonth.forEach(match => {
          if (selectedOdds === 'has_odds' && !match.hasOdds) return;
          if (selectedOdds === 'no_odds' && match.hasOdds) return;
          result.push({ ...match, year: y, month: m });
        });
      });
    });

    return result;
  }, [historyData, selectedYear, selectedMonth, selectedOdds, years]);

  const selectStyle = {
    padding: '0.5rem 0.75rem',
    background: 'rgba(15, 23, 42, 0.6)',
    border: '1px solid var(--panel-border)',
    borderRadius: '0.5rem',
    color: 'var(--text-primary)',
    fontSize: '0.85rem',
    outline: 'none'
  };

  return (
    <section className="glass-panel animate-fade-in" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      
      {/* Başlık ve Filtreler */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', borderBottom: '1px solid var(--panel-border)', paddingBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <History size={20} color="var(--accent)" />
          <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Geçmiş Karşılaşmalar Arşivi</h3>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Yıl:</span>
            <select value={selectedYear} onChange={(e) => setSelectedYear(e.target.value)} style={selectStyle}>
              <option value="all">Tümü</option>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Ay:</span>
            <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} style={selectStyle}>
              <option value="all">Tümü</option>
              {availableMonths.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Oran:</span>
            <select value={selectedOdds} onChange={(e) => setSelectedOdds(e.target.value)} style={selectStyle}>
              <option value="all">Tümü</option>
              <option value="has_odds">Nesine Oranlı</option>
              <option value="no_odds">Oransız</option>
            </select>
          </div>
        </div>
      </div>

      {/* Maç Listesi */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '0.75rem', maxHeight: '380px', overflowY: 'auto', paddingRight: '0.25rem' }}>
        {filteredMatches.length === 0 ? (
          <div style={{ gridColumn: '1 / -1', padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Seçilen filtrelere uygun geçmiş maç bulunamadı.
          </div>
        ) : (
          filteredMatches.map((m, idx) => (
            <div 
              key={idx}
              className="glass-card"
              style={{
                padding: '0.875rem',
                borderRadius: '0.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                cursor: onSelectMatch ? 'pointer' : 'default',
                transition: 'all 0.2s'
              }}
              onClick={() => onSelectMatch && onSelectMatch(m.homeTeam, m.awayTeam)}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(16, 185, 129, 0.4)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--panel-border)'; }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                <span>{m.date || `${m.year}-${m.month}`}</span>
                <span style={{ color: m.hasOdds ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 600 }}>
                  {m.hasOdds ? '● Nesine Oranı Var' : '○ Oran Yok'}
                </span>
              </div>

              <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                {m.homeTeam} - {m.awayTeam}
              </div>

              {m.score && (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  Skor: <strong style={{ color: 'var(--text-primary)' }}>{m.score}</strong>
                </div>
              )}
            </div>
          ))
        )}
      </div>

    </section>
  );
}
