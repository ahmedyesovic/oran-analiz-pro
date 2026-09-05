/**
 * Yardımcı Araçlar ve Panoya Kopyalama Biçimlendirici
 * Copy = Pazar + Seçenek: Oran
 * Metadata (maç adı, kodu, tarihi, marka, üretim bilgisi) kesinlikle eklenmez.
 */

function isValidOdd(val) {
  if (val === null || val === undefined) return false;
  const s = String(val).trim();
  if (s === '' || s === '-' || s === '—' || s === 'null' || s === 'undefined') return false;
  return true;
}

/**
 * Veri modelindeki tüm oranları satır satır formatta metne dönüştürür.
 * Format: [Pazar Adı] [Seçenek Adı]: [Oran]
 * Metadata eklenmez. Boş/eksik oranlar gösterilmez.
 */
export function formatOddsForClipboard(parsedData) {
  if (!parsedData) return '';

  const lines = [];

  // 1. markets hiyerarşik objesi varsa (Kategori > Pazar > Seçenek > Oran)
  if (parsedData.markets && typeof parsedData.markets === 'object') {
    for (const [, markets] of Object.entries(parsedData.markets)) {
      if (!markets || typeof markets !== 'object') continue;
      for (const [marketName, outcomes] of Object.entries(markets)) {
        if (!outcomes || typeof outcomes !== 'object') continue;
        for (const [outcomeName, oddValue] of Object.entries(outcomes)) {
          if (!isValidOdd(oddValue)) continue;
          lines.push(`${marketName} ${outcomeName}: ${String(oddValue).trim()}`);
        }
      }
    }
    if (lines.length > 0) return lines.join('\n');
  }

  // 2. formattedMarkets dizisi varsa
  if (Array.isArray(parsedData.formattedMarkets) && parsedData.formattedMarkets.length > 0) {
    for (const market of parsedData.formattedMarkets) {
      if (Array.isArray(market.odds)) {
        for (const odd of market.odds) {
          if (!isValidOdd(odd.value)) continue;
          lines.push(`${market.category} ${odd.name}: ${String(odd.value).trim()}`);
        }
      }
    }
    if (lines.length > 0) return lines.join('\n');
  }

  return '';
}

/**
 * Metni panoya kopyalar.
 */
export async function copyToClipboard(text) {
  if (!text) return false;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textarea);
      return successful;
    }
  } catch (err) {
    console.error('Panoya kopyalama başarısız:', err);
    return false;
  }
}
