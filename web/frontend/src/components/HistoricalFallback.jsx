import React from 'react';
import { Info } from 'lucide-react';
import BandClassification from './BandClassification';

export default function HistoricalFallback({ message, classification }) {
  return (
    <div className="glass-panel animate-fade-in" style={{ padding: '2rem', textAlign: 'center' }}>
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--warning-bg)',
        border: '1px solid var(--warning-border-strong)',
        color: 'var(--warning)',
        padding: '1.5rem',
        borderRadius: '1rem',
        gap: '0.75rem',
        maxWidth: '600px',
        margin: '0 auto'
      }}>
        <Info size={24} style={{ flexShrink: 0 }} />
        <p style={{ margin: 0, fontWeight: 500, lineHeight: 1.5, fontSize: '0.95rem' }}>
          {message}
        </p>
      </div>
      <div style={{ marginTop: '1rem' }}><BandClassification result={classification} /></div>
    </div>
  );
}
