import React, { useState } from 'react';
import { Calendar, Download, Copy, Check, ChevronDown, ChevronUp, Image, Layers, ShieldCheck } from 'lucide-react';
import { 
  exportAllCategoriesAsPNG, 
  createCategoryExportElement, 
  renderElementToPNGBlob, 
  downloadBlob, 
  cleanTeamSlug, 
  categoryToSlug 
} from '../utils/aiExportRenderer';
import { formatOddsForClipboard, copyToClipboard } from '../utils/helpers';

export default function MatchResult({ data }) {
  if (!data || !data.match) return null;

  const { match, markets = {}, isHistorical, oddsProvider, dataSource } = data;
  const categoriesList = Object.entries(markets || {});

  // Açık olan akordeon sekmelerinin state'i (ilk kategori varsayılan açık)
  const [openCategories, setOpenCategories] = useState(() => {
    const initial = {};
    if (categoriesList.length > 0) {
      initial[categoriesList[0][0]] = true;
    }
    return initial;
  });

  const [copied, setCopied] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);
  const [exportProgress, setExportProgress] = useState(null); // { current, total, categoryName }
  const [exportingSingle, setExportingSingle] = useState({}); // { [catName]: true/false }

  const toggleCategory = (catName) => {
    setOpenCategories(prev => ({
      ...prev,
      [catName]: !prev[catName]
    }));
  };

  const handleCopy = async () => {
    const text = formatOddsForClipboard(data);
    const success = await copyToClipboard(text || 'Geçerli oran bulunamadı.');
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleExportAll = async () => {
    if (exportingAll) return;
    setExportingAll(true);
    setExportProgress({ current: 0, total: 8, categoryName: 'Başlatılıyor...' });

    try {
      await exportAllCategoriesAsPNG({
        match: {
          home: match.home,
          away: match.away,
          name: match.name,
          code: match.code,
          date: match.date,
          time: match.time
        },
        categories: markets,
        onProgress: ({ current, total, categoryName, status }) => {
          setExportProgress({ current, total, categoryName, status });
        }
      });
      setTimeout(() => setExportProgress(null), 3500);
    } catch (err) {
      console.error('AI Export Hatası:', err);
      alert('Görseller oluşturulurken hata oluştu: ' + err.message);
      setExportProgress(null);
    } finally {
      setExportingAll(false);
    }
  };

  const handleExportSingle = async (e, catName, catMarkets) => {
    e.stopPropagation();
    if (exportingSingle[catName]) return;

    setExportingSingle(prev => ({ ...prev, [catName]: true }));

    try {
      const domEl = createCategoryExportElement(match, catName, catMarkets);
      if (domEl) {
        const blob = await renderElementToPNGBlob(domEl);
        const homeSlug = cleanTeamSlug(match.home);
        const awaySlug = cleanTeamSlug(match.away);
        const code = match.code || 'NOCODE';
        const catSlug = categoryToSlug(catName);
        downloadBlob(blob, `${homeSlug}_vs_${awaySlug}_${code}_${catSlug}.png`);
      } else {
        alert('Bu kategoride indirilecek açık oran bulunamadı.');
      }
    } catch (err) {
      console.error('Kategori PNG Hatası:', err);
      alert('Görsel oluşturulamadı: ' + err.message);
    } finally {
      setExportingSingle(prev => ({ ...prev, [catName]: false }));
    }
  };

  return (
    <section className="glass-panel animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', padding: '1.75rem' }}>
      
      {/* Üst Bilgi Kartı */}
      <div className="glass-card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', alignItems: 'center', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
        
        {/* Rozetler */}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center' }}>
          {isHistorical ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', background: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', border: '1px solid rgba(245, 158, 11, 0.3)', padding: '0.3rem 0.75rem', borderRadius: '9999px', fontSize: '0.8rem', fontWeight: 600 }}>
              <ShieldCheck size={14} /> Geçmiş Arşiv • {dataSource || 'Mackolik'} ({oddsProvider || 'Nesine'})
            </span>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', background: 'rgba(16, 185, 129, 0.15)', color: 'var(--accent)', border: '1px solid rgba(16, 185, 129, 0.3)', padding: '0.3rem 0.75rem', borderRadius: '9999px', fontSize: '0.8rem', fontWeight: 600 }}>
              ● Canlı Nesine Bülteni
            </span>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 500 }}>
            <Calendar size={15} />
            <span>{match.date} {match.time || ''}</span>
            <span>•</span>
            <span>Kod: <strong>{match.code}</strong></span>
          </div>
        </div>

        <h2 style={{ fontSize: '2rem', fontWeight: 700, margin: '0.25rem 0', letterSpacing: '-0.5px' }}>
          {match.name || `${match.home} - ${match.away}`}
        </h2>

        {data.confidence && (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Eşleşme Doğruluğu: <strong style={{ color: 'var(--accent)' }}>%{data.confidence}</strong>
          </div>
        )}
      </div>

      {/* Aksiyon Butonları */}
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <button 
          onClick={handleExportAll}
          disabled={exportingAll}
          style={{ 
            flex: 1, 
            minWidth: '220px',
            padding: '0.875rem 1.25rem', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            gap: '0.6rem', 
            background: exportingAll ? 'rgba(16, 185, 129, 0.2)' : 'rgba(16, 185, 129, 0.12)', 
            color: 'var(--accent)', 
            border: '1px solid var(--accent)', 
            borderRadius: '0.75rem', 
            cursor: exportingAll ? 'wait' : 'pointer', 
            fontWeight: 600, 
            transition: 'all 0.2s',
            fontSize: '0.95rem'
          }}
        >
          <Download size={18} />
          {exportingAll ? 'PNG Görselleri İndiriliyor...' : 'AI Görsellerini İndir (Tüm Pazarlar)'}
        </button>

        <button 
          onClick={handleCopy}
          style={{ 
            flex: 1, 
            minWidth: '200px',
            padding: '0.875rem 1.25rem', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            gap: '0.6rem', 
            background: copied ? 'rgba(16, 185, 129, 0.15)' : 'rgba(255, 255, 255, 0.05)', 
            color: copied ? 'var(--accent)' : 'var(--text-primary)', 
            border: copied ? '1px solid var(--accent)' : '1px solid var(--panel-border)', 
            borderRadius: '0.75rem', 
            cursor: 'pointer', 
            fontWeight: 600, 
            transition: 'all 0.2s',
            fontSize: '0.95rem'
          }}
        >
          {copied ? <><Check size={18} /> Kopyalandı!</> : <><Copy size={18} /> Tüm Oranları Kopyala</>}
        </button>
      </div>

      {/* AI Export İlerleme Çubuğu */}
      {exportProgress && (
        <div className="glass-card animate-fade-in" style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', background: 'rgba(16, 185, 129, 0.08)', border: '1px solid var(--accent)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 600, color: 'var(--accent)' }}>
            <span>{exportProgress.categoryName} hazırlanıyor...</span>
            <span>{exportProgress.current} / {exportProgress.total}</span>
          </div>
          <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ width: `${Math.round((exportProgress.current / exportProgress.total) * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.3s ease' }} />
          </div>
        </div>
      )}

      {/* Kategoriler Akordeonu */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {categoriesList.length === 0 ? (
          <div className="glass-card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            Geçerli oran verisi bulunamadı.
          </div>
        ) : (
          categoriesList.map(([catName, catMarkets]) => {
            const marketEntries = Object.entries(catMarkets || {});
            const isOpen = !!openCategories[catName];
            const isSingleLoading = !!exportingSingle[catName];

            return (
              <div 
                key={catName} 
                className="glass-card" 
                style={{ 
                  borderRadius: '0.75rem', 
                  overflow: 'hidden', 
                  border: isOpen ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid var(--panel-border)',
                  transition: 'all 0.2s'
                }}
              >
                {/* Kategori Başlığı / Toggle */}
                <div 
                  onClick={() => toggleCategory(catName)}
                  style={{ 
                    padding: '1rem 1.25rem', 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center', 
                    cursor: 'pointer',
                    background: isOpen ? 'rgba(255, 255, 255, 0.04)' : 'transparent',
                    userSelect: 'none'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--text-primary)' }}>
                      {catName}
                    </span>
                    <span style={{ 
                      fontSize: '0.75rem', 
                      padding: '0.2rem 0.5rem', 
                      background: 'rgba(255, 255, 255, 0.08)', 
                      borderRadius: '9999px', 
                      color: 'var(--text-secondary)',
                      fontWeight: 500
                    }}>
                      {marketEntries.length} Pazar
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {marketEntries.length > 0 && (
                      <button
                        onClick={(e) => handleExportSingle(e, catName, catMarkets)}
                        disabled={isSingleLoading}
                        title={`${catName} PNG İndir`}
                        style={{
                          background: 'rgba(255, 255, 255, 0.08)',
                          border: 'none',
                          color: isSingleLoading ? 'var(--accent)' : 'var(--text-secondary)',
                          padding: '0.35rem 0.6rem',
                          borderRadius: '0.4rem',
                          cursor: isSingleLoading ? 'wait' : 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.3rem',
                          fontSize: '0.75rem',
                          fontWeight: 500,
                          transition: 'all 0.15s'
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(16, 185, 129, 0.2)'; e.currentTarget.style.color = 'var(--accent)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                      >
                        <Image size={14} />
                        <span>{isSingleLoading ? '⏳' : 'PNG'}</span>
                      </button>
                    )}
                    {isOpen ? <ChevronUp size={18} color="var(--text-secondary)" /> : <ChevronDown size={18} color="var(--text-secondary)" />}
                  </div>
                </div>

                {/* Açılır Gövde */}
                {isOpen && (
                  <div style={{ padding: '1rem 1.25rem', borderTop: '1px solid var(--panel-border)', display: 'flex', flexDirection: 'column', gap: '1rem', background: 'rgba(0, 0, 0, 0.2)' }}>
                    {marketEntries.length === 0 ? (
                      <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center' }}>
                        Bu kategoride açık oran bulunamadı.
                      </div>
                    ) : (
                      marketEntries.map(([marketName, outcomes], mIdx) => (
                        <div key={mIdx} style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                            {marketName}
                          </div>
                          
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))', gap: '0.5rem' }}>
                            {Object.entries(outcomes || {}).map(([outName, oddVal], oIdx) => (
                              <div 
                                key={oIdx} 
                                style={{ 
                                  background: 'rgba(15, 23, 42, 0.7)', 
                                  border: '1px solid var(--panel-border)', 
                                  borderRadius: '0.5rem', 
                                  padding: '0.5rem 0.75rem', 
                                  display: 'flex', 
                                  flexDirection: 'column', 
                                  alignItems: 'center', 
                                  justifyContent: 'center',
                                  gap: '0.2rem' 
                                }}
                              >
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                                  {outName}
                                </span>
                                <span style={{ fontSize: '0.95rem', color: 'var(--accent)', fontWeight: 700 }}>
                                  {oddVal}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

              </div>
            );
          })
        )}
      </div>

    </section>
  );
}
