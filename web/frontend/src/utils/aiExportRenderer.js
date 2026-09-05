/**
 * AI Uyumlu Görsel Çıktı Motoru (AI Export Renderer)
 * PNG = Kategori + Pazar + Seçenek + Oran
 * Hiçbir metadata (maç adı, kodu, tarih, marka, üretim bilgisi) içermez.
 */
import html2canvas from 'html2canvas';

export const AI_CATEGORIES = [
  "MAÇ SONUCU",
  "YARI SONUCU",
  "MAÇ SONUCU ALT/ÜST",
  "YARI ALT/ÜST",
  "TARAF ALT/ÜST",
  "GOL",
  "TOPLAM GOL",
  "MAÇ SKORU"
];

export function categoryToSlug(categoryName) {
  const trMap = {
    'Ç': 'C', 'ç': 'c', 'Ğ': 'G', 'ğ': 'g', 'İ': 'I', 'ı': 'i',
    'Ö': 'O', 'ö': 'o', 'Ş': 'S', 'ş': 's', 'Ü': 'U', 'ü': 'u',
    '/': '_', ' ': '_'
  };
  return categoryName
    .replace(/[ÇçĞğİıÖöŞşÜü/ ]/g, m => trMap[m] || '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .toUpperCase();
}

export function cleanTeamSlug(name) {
  if (!name) return 'MAC';
  const trMap = {
    'Ç': 'C', 'ç': 'c', 'Ğ': 'G', 'ğ': 'g', 'İ': 'I', 'ı': 'i',
    'Ö': 'O', 'ö': 'o', 'Ş': 'S', 'ş': 's', 'Ü': 'U', 'ü': 'u'
  };
  return name
    .replace(/[ÇçĞğİıÖöŞşÜü]/g, m => trMap[m] || '')
    .replace(/[^A-Za-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .toUpperCase();
}

function isValidOdd(val) {
  if (val === null || val === undefined) return false;
  const s = String(val).trim();
  if (s === '' || s === '-' || s === '—' || s === 'null' || s === 'undefined') return false;
  return true;
}

/**
 * Tek bir kategori için sade PNG DOM elemanı oluşturur.
 * İÇERİK: Kategori Başlığı → Pazar → Seçenek → Oran
 * METADATA YOK: Maç adı, kodu, tarihi, marka, üretim bilgisi kesinlikle eklenmez.
 */
export function createCategoryExportElement(match, categoryName, markets) {
  const marketEntries = Object.entries(markets || {}).filter(([_, odds]) => {
    if (!odds || typeof odds !== 'object') return false;
    return Object.entries(odds).some(([__, v]) => isValidOdd(v));
  });

  if (marketEntries.length === 0) return null;

  const container = document.createElement('div');
  container.style.cssText = `
    width: 1200px;
    background-color: #FFFFFF;
    color: #111827;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 32px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 20px;
    border: 2px solid #E5E7EB;
  `;

  // KATEGORİ BAŞLIĞI (tek üst bilgi — metadata yok)
  const header = document.createElement('div');
  header.style.cssText = `
    border-bottom: 3px solid #111827;
    padding-bottom: 12px;
  `;
  const categoryTitle = document.createElement('h1');
  categoryTitle.style.cssText = `
    margin: 0;
    font-size: 28px;
    font-weight: 800;
    color: #0F172A;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `;
  categoryTitle.textContent = categoryName;
  header.appendChild(categoryTitle);
  container.appendChild(header);

  // PAZARLAR & ORANLAR
  const marketsContainer = document.createElement('div');
  marketsContainer.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 16px;
  `;

  for (const [marketName, odds] of marketEntries) {
    const oddEntries = Object.entries(odds || {}).filter(([_, v]) => isValidOdd(v));
    if (oddEntries.length === 0) continue;

    const marketBox = document.createElement('div');
    marketBox.style.cssText = `
      border: 1px solid #D1D5DB;
      border-radius: 8px;
      background-color: #F9FAFB;
      overflow: hidden;
    `;

    const marketTitle = document.createElement('div');
    marketTitle.style.cssText = `
      background-color: #F3F4F6;
      border-bottom: 1px solid #D1D5DB;
      padding: 10px 16px;
      font-size: 18px;
      font-weight: 700;
      color: #1F2937;
    `;
    marketTitle.textContent = marketName;
    marketBox.appendChild(marketTitle);

    const oddsGrid = document.createElement('div');
    oddsGrid.style.cssText = `
      display: grid;
      grid-template-columns: repeat(${Math.min(oddEntries.length, 6)}, 1fr);
      gap: 1px;
      background-color: #E5E7EB;
      padding: 1px;
    `;

    for (const [outcomeName, oddValue] of oddEntries) {
      const oddCell = document.createElement('div');
      oddCell.style.cssText = `
        background-color: #FFFFFF;
        padding: 14px 10px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 4px;
        text-align: center;
      `;

      const nameLabel = document.createElement('span');
      nameLabel.style.cssText = `
        font-size: 14px;
        font-weight: 600;
        color: #4B5563;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
      `;
      nameLabel.textContent = outcomeName;

      const valLabel = document.createElement('span');
      valLabel.style.cssText = `
        font-size: 22px;
        font-weight: 800;
        color: #047857;
      `;
      valLabel.textContent = String(oddValue).trim();

      oddCell.appendChild(nameLabel);
      oddCell.appendChild(valLabel);
      oddsGrid.appendChild(oddCell);
    }

    marketBox.appendChild(oddsGrid);
    marketsContainer.appendChild(marketBox);
  }

  container.appendChild(marketsContainer);

  // FOOTER YOK — container burada biter
  return container;
}

export async function renderElementToPNGBlob(element) {
  const exportRoot = document.createElement('div');
  exportRoot.style.cssText = `
    position: fixed;
    top: -99999px;
    left: -99999px;
    width: 1200px;
    z-index: -1000;
    opacity: 1;
    pointer-events: none;
  `;
  exportRoot.appendChild(element);
  document.body.appendChild(exportRoot);

  try {
    const canvas = await html2canvas(element, {
      scale: 2,
      width: 1200,
      windowWidth: 1200,
      backgroundColor: '#FFFFFF',
      useCORS: true,
      logging: false,
      allowTaint: true
    });

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Canvas PNG Blob oluşturulamadı.'));
        }
      }, 'image/png');
    });
  } finally {
    if (exportRoot.parentNode) {
      document.body.removeChild(exportRoot);
    }
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

export async function exportAllCategoriesAsPNG({ match, categories, onProgress }) {
  if (!categories || typeof categories !== 'object') {
    throw new Error('Geçerli kategori verisi bulunamadı.');
  }

  const generatedFiles = [];
  const validCategories = AI_CATEGORIES.filter(catName => {
    const markets = categories[catName];
    if (!markets) return false;
    return Object.values(markets).some(odds => {
      if (!odds || typeof odds !== 'object') return false;
      return Object.entries(odds).some(([_, v]) => isValidOdd(v));
    });
  });

  const total = validCategories.length;
  if (total === 0) {
    throw new Error('İndirilecek geçerli bahis pazarı bulunamadı.');
  }

  // Dosya adında takım adı ve kod kullanılır (PNG içeriğinde değil)
  const homeSlug = cleanTeamSlug(match.home);
  const awaySlug = cleanTeamSlug(match.away);
  const matchCode = match.code || 'NOCODE';

  let current = 0;
  for (const categoryName of validCategories) {
    current++;
    const catSlug = categoryToSlug(categoryName);
    const filename = `${homeSlug}_vs_${awaySlug}_${matchCode}_${catSlug}.png`;

    if (typeof onProgress === 'function') {
      onProgress({ current, total, categoryName, filename, status: 'rendering' });
    }

    const domElement = createCategoryExportElement(match, categoryName, categories[categoryName]);
    if (!domElement) continue;

    const blob = await renderElementToPNGBlob(domElement);
    downloadBlob(blob, filename);
    generatedFiles.push(filename);

    if (typeof onProgress === 'function') {
      onProgress({ current, total, categoryName, filename, status: 'downloaded' });
    }

    await new Promise(resolve => setTimeout(resolve, 400));
  }

  return generatedFiles;
}
