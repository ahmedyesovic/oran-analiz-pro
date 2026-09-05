import React from 'react';
import { Info } from 'lucide-react';

export default function HistoricalFallback({ message }) {
  return (
    <div className="glass-panel animate-fade-in" style={{ padding: '2rem', textAlign: 'center' }}>
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(245, 158, 11, 0.1)',
        border: '1px solid rgba(245, 158, 11, 0.5)',
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
    </div>
  );
}
