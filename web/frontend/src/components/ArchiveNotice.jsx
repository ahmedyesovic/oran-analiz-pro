import React from 'react';

export default function ArchiveNotice({ archiveCache }) {
  const savedAt = archiveCache?.savedAt;
  const date = savedAt ? new Date(savedAt) : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  return <p className="archive-notice" role="status">
    {archiveCache.stale ? 'Kaydedilmiş arşiv gösteriliyor' : 'Arşiv kaydı'}
    {' · Kaydedildi: '}<time dateTime={savedAt}>{date.toLocaleString('tr-TR')}</time>
  </p>;
}
