import React from 'react';

export default function BandClassification({ result }) {
  if (!result?.lines?.length) return null;
  return (
    <div role="status" aria-label="Kod oran aralığı" style={{
      maxWidth: '100%', overflowWrap: 'anywhere', display: 'flex', flexDirection: 'column',
      gap: '0.35rem', padding: '0.75rem 1rem', borderRadius: '0.75rem',
      background: 'var(--neutral-subtle)', border: '1px solid var(--panel-border)'
    }}>
      {result.lines.map((line, index) => (
        <div key={index} style={{
          color: index === 0 && result.status === 'classified' ? 'var(--accent)' : 'var(--text-secondary)',
          fontSize: index === 0 ? '1rem' : '0.85rem', fontWeight: index === 0 ? 600 : 400
        }}>{line}</div>
      ))}
    </div>
  );
}
