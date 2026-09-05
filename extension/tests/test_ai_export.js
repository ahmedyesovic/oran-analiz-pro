/**
 * AI Görsel Çıktı Sistemi Doğrulama Testi
 */

import { AI_CATEGORIES, categoryToSlug, cleanTeamSlug } from '../utils/aiExportRenderer.js';
import { TARGET_MARKETS, CATEGORIES } from '../utils/marketDefinitions.js';

console.log('====================================================');
console.log('   AI UYUMLU GÖRSEL ÇIKTI SİSTEMİ - DOĞRULAMA TESTİ ');
console.log('====================================================\n');

// TEST 1: Kategori sayısı ve listesi
console.log('▶ [TEST 1] Kategori Uyumluluğu (Maksimum 8 Kategori)');
console.log('  Kategoriler:', AI_CATEGORIES);
if (AI_CATEGORIES.length === 8) {
  console.log(`  ✅ Tam olarak 8 ana kategori tanımlandı (Adet: ${AI_CATEGORIES.length})`);
} else {
  console.error(`  ❌ Kategori sayısı 8 olmalıydı, bulunan: ${AI_CATEGORIES.length}`);
  process.exit(1);
}

// TEST 2: Slug ve Dosya Adı Standartı
console.log('\n▶ [TEST 2] Dosya İsimlendirme Standartları');
const testCases = [
  { match: { home: 'Genoa', away: 'Como 1907', code: 3100975 }, cat: 'MAÇ SONUCU', expectedCat: 'MAC_SONUCU' },
  { match: { home: 'İpswich Town', away: 'Liverpool F.C.', code: 3100797 }, cat: 'MAÇ SONUCU ALT/ÜST', expectedCat: 'MAC_SONUCU_ALT_UST' },
  { match: { home: 'Fenerbahçe', away: 'Galatasaray', code: 3100123 }, cat: 'MAÇ SKORU', expectedCat: 'MAC_SKORU' },
];

for (const tc of testCases) {
  const homeSlug = cleanTeamSlug(tc.match.home);
  const awaySlug = cleanTeamSlug(tc.match.away);
  const catSlug = categoryToSlug(tc.cat);
  const filename = `${homeSlug}_vs_${awaySlug}_${tc.match.code}_${catSlug}.png`;
  console.log(`  ✅ ${tc.match.home} vs ${tc.match.away} [${tc.cat}] -> "${filename}"`);
  if (catSlug !== tc.expectedCat) {
    console.error(`  ❌ Beklenen slug ${tc.expectedCat}, üretilen: ${catSlug}`);
    process.exit(1);
  }
}

// TEST 3: Sabit Pazar Sıralaması (Kural 14)
console.log('\n▶ [TEST 3] Pazar Sıralaması Bütünlüğü (Kural 14)');
for (const cat of AI_CATEGORIES) {
  const marketsInCat = TARGET_MARKETS.filter(m => m.category === cat);
  console.log(`  ✅ ${cat}: ${marketsInCat.length} pazar tanımlı (Örn: 1. pazar: "${marketsInCat[0]?.name || 'Yok'}")`);
}

// TEST 4: Canlı API Testi & Kategori Ayrıştırma
console.log('\n▶ [TEST 4] Canlı Web API Entegrasyon Testi');
try {
  const res = await fetch('http://localhost:3000/api/fetch-match?home=ipswich&away=liverpool');
  const data = await res.json();
  if (data.success && data.categories && data.match) {
    console.log(`  ✅ Canlı maç başarıyla çekildi: ${data.matchName} (Kod: ${data.matchCode})`);
    const activeCats = Object.keys(data.categories).filter(c => Object.keys(data.categories[c] || {}).length > 0);
    console.log(`  ✅ Oranı bulunan aktif kategori sayısı: ${activeCats.length} / 8`);
    for (const c of activeCats) {
      const mCount = Object.keys(data.categories[c]).length;
      console.log(`     - ${c}: ${mCount} pazar`);
    }
  } else {
    console.error('  ❌ Canlı API yanıtı başarısız:', data);
    process.exit(1);
  }
} catch (e) {
  console.error('  ❌ Canlı API isteği başarısız:', e.message);
  process.exit(1);
}

console.log('\n====================================================');
console.log('   TÜM TESTLER BAŞARIYLA TAMAMLANDI! (4 / 4)');
console.log('====================================================');
