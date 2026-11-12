import React from 'react';

export default function ArchiveNotice({ archiveCache, latestVerified, refresh, observationEnded = false }) {
  const savedAt = archiveCache?.savedAt;
  const date = savedAt ? new Date(savedAt) : null;
  const validDate = date && Number.isFinite(date.getTime());
  const pending = !observationEnded && ['queued', 'running', 'backoff'].includes(refresh?.state);
  const failed = !observationEnded && refresh?.state === 'failed';
  if (!validDate && latestVerified !== false && !pending && !failed) return null;
  return <p className="archive-notice" role="status">
    {latestVerified === false && <>En yeni maç kontrol edilemedi; son doğrulanmış arşiv gösteriliyor.<br /></>}
    {pending && <>En yeni maç arka planda kontrol ediliyor.<br /></>}
    {failed && <>Kaynak şu anda doğrulanamıyor; otomatik kontrol tamamlanamadı.<br /></>}
    {validDate && <>
      {archiveCache.stale ? 'Kaydedilmiş arşiv gösteriliyor' : 'Arşiv kaydı'}
      {' · Kaydedildi: '}<time dateTime={savedAt}>{date.toLocaleString('tr-TR')}</time>
    </>}
  </p>;
}
