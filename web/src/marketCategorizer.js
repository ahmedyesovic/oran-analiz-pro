/**
 * 8 Temel Bahis Başlığı Sınıflandırıcısı
 */

export const MAIN_CATEGORIES = [
  "MAÇ SONUCU",
  "YARI SONUCU",
  "MAÇ SONUCU ALT/ÜST",
  "YARI ALT/ÜST",
  "TARAF ALT/ÜST",
  "GOL",
  "TOPLAM GOL",
  "MAÇ SKORU"
];

function cleanText(str) {
  if (!str) return '';
  return str
    .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
    .replace(/Ç/g, "c").replace(/ç/g, "c")
    .replace(/Ş/g, "s").replace(/ş/g, "s")
    .replace(/Ğ/g, "g").replace(/ğ/g, "g")
    .replace(/Ü/g, "u").replace(/ü/g, "u")
    .replace(/Ö/g, "o").replace(/ö/g, "o")
    .toLowerCase()
    .replace(/,/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Verilen pazar ismini 8 ana başlıktan birine eşler.
 * @param {string} marketName 
 * @returns {string} Ana kategori başlığı
 */
export function categorizeMarket(marketName) {
  const norm = cleanText(marketName);

  // 8. BAŞLIK: MAÇ SKORU
  if (norm.includes("skor")) {
    return "MAÇ SKORU";
  }

  // 1. BAŞLIK: MAÇ SONUCU
  if (norm === "mac sonucu" || norm === "cifte sans") {
    return "MAÇ SONUCU";
  }
  if (norm.startsWith("hnd. ms") || norm.startsWith("hnd ms") || norm.includes("handikap")) {
    return "MAÇ SONUCU";
  }
  if (norm.includes("ilk yari / mac sonucu") || norm.includes("ilk yari/mac sonucu") || norm.includes("iy/ms") || norm.includes("iy / ms")) {
    return "MAÇ SONUCU";
  }
  if (norm.startsWith("ms ve") || norm.startsWith("ms &") || norm.includes("farkla kazanir") || norm.includes("gol yemeden kazanir")) {
    return "MAÇ SONUCU";
  }

  // Korner & Kart (Öncelikli olarak korner/kart alt/üstlerini de yakalamak için)
  if (norm.includes("korner") || norm.includes("kart")) {
    return "KORNER & KART";
  }

  // 5. BAŞLIK: TARAF ALT/ÜST (Ev Sahibi Alt/Üst, Deplasman Alt/Üst, 1. Yarı Ev Sahibi / Deplasman Alt/Üst)
  if ((norm.includes("ev sahibi") || norm.includes("deplasman")) && (norm.includes("alt/ust") || norm.includes("alt") || norm.includes("ust")) && !norm.includes("iki yari")) {
    return "TARAF ALT/ÜST";
  }

  // 4. BAŞLIK: YARI ALT/ÜST
  if (norm.includes("yari") && (norm.includes("alt/ust") || norm.includes("alt") || norm.includes("ust")) && !norm.includes("ev sahibi") && !norm.includes("deplasman")) {
    return "YARI ALT/ÜST";
  }
  if (norm.includes("iki yari da 1.5") || norm.includes("iki yari da 2.5")) {
    return "YARI ALT/ÜST";
  }

  // 3. BAŞLIK: MAÇ SONUCU ALT/ÜST
  if (norm.includes("alt/ust") || (norm.includes("alt") && norm.includes("ust"))) {
    return "MAÇ SONUCU ALT/ÜST";
  }

  // 2. BAŞLIK: YARI SONUCU
  if (norm.includes("yari sonucu") || norm.includes("yari cifte sans") || norm.includes("yari ve 1.yari kg") || norm.includes("yari kazanir") || norm.includes("iki yariyi da kazanir") || norm.includes("iki yariyi da (yari) kazanir") || norm.includes("iki yariy da kazanir")) {
    return "YARI SONUCU";
  }

  // 7. BAŞLIK: TOPLAM GOL
  if (norm.includes("toplam gol") || norm.includes("en cok gol olacak yari") || norm.includes("tek/cift")) {
    return "TOPLAM GOL";
  }

  // 6. BAŞLIK: GOL
  if (norm.includes("karsilikli gol") || norm.includes("ilk gol") || norm.includes("gol atar") || norm.includes("hangi yarida daha cok gol") || norm.includes("kg")) {
    return "GOL";
  }

  return "DİĞER";
}
