/**
 * Nesine Futbol Bahis Pazarları ve Seçenek Tanımları
 * MTID (Market Type ID), SOV (Special Odds Value) ve Seçenek İsimleri (Outcome Masks)
 */

export const CATEGORIES = {
  MAC_SONUCU: "MAÇ SONUCU",
  YARI_SONUCU: "YARI SONUCU",
  MAC_SONUCU_ALT_UST: "MAÇ SONUCU ALT/ÜST",
  YARI_ALT_UST: "YARI ALT/ÜST",
  TARAF_ALT_UST: "TARAF ALT/ÜST",
  GOL: "GOL",
  TOPLAM_GOL: "TOPLAM GOL",
  MAC_SKORU: "MAÇ SKORU"
};

/**
 * Hedeflenen 8 kategori altındaki tüm bahis pazarlarının konfigürasyonu.
 */
export const TARGET_MARKETS = [
  // ==========================================
  // 1. MAÇ SONUCU
  // ==========================================
  {
    id: "ms",
    category: CATEGORIES.MAC_SONUCU,
    name: "Maç Sonucu",
    mtid: 1,
    sov: 0.0,
    outcomeMap: { 1: "1", 2: "X", 3: "2" }
  },
  {
    id: "cifte_sans",
    category: CATEGORIES.MAC_SONUCU,
    name: "Çifte Şans",
    mtid: 3,
    sov: 0.0,
    outcomeMap: { 1: "1-X", 2: "1-2", 3: "X-2" }
  },
  {
    id: "hnd_ms_0_2",
    category: CATEGORIES.MAC_SONUCU,
    name: "HND. MS (0:2)",
    mtid: 268,
    sov: -2.0,
    outcomeMap: { 1: "1", 2: "X", 3: "2" }
  },
  {
    id: "hnd_ms_0_1",
    category: CATEGORIES.MAC_SONUCU,
    name: "HND. MS (0:1)",
    mtid: 268,
    sov: -1.0,
    outcomeMap: { 1: "1", 2: "X", 3: "2" }
  },
  {
    id: "hnd_ms_1_0",
    category: CATEGORIES.MAC_SONUCU,
    name: "HND. MS (1:0)",
    mtid: 268,
    sov: 1.0,
    outcomeMap: { 1: "1", 2: "X", 3: "2" }
  },
  {
    id: "hnd_ms_2_0",
    category: CATEGORIES.MAC_SONUCU,
    name: "HND. MS (2:0)",
    mtid: 268,
    sov: 2.0,
    outcomeMap: { 1: "1", 2: "X", 3: "2" }
  },
  {
    id: "iy_ms",
    category: CATEGORIES.MAC_SONUCU,
    name: "İlk Yarı / Maç Sonucu",
    mtid: 5,
    sov: 0.0,
    outcomeMap: {
      1: "1/1", 2: "1/X", 3: "1/2",
      4: "X/1", 5: "X/X", 6: "X/2",
      7: "2/1", 8: "2/X", 9: "2/2"
    }
  },
  {
    id: "ms_ve_1_5",
    category: CATEGORIES.MAC_SONUCU,
    name: "MS ve 1.5 Alt/Üst",
    mtid: 342,
    sov: 1.5,
    outcomeMap: {
      1: "1 ve Alt", 2: "X ve Alt", 3: "2 ve Alt",
      4: "1 ve Üst", 5: "X ve Üst", 6: "2 ve Üst"
    }
  },
  {
    id: "ms_ve_2_5",
    category: CATEGORIES.MAC_SONUCU,
    name: "MS ve 2.5 Alt/Üst",
    mtid: 343,
    sov: 2.5,
    outcomeMap: {
      1: "1 ve Alt", 2: "X ve Alt", 3: "2 ve Alt",
      4: "1 ve Üst", 5: "X ve Üst", 6: "2 ve Üst"
    }
  },
  {
    id: "ms_ve_3_5",
    category: CATEGORIES.MAC_SONUCU,
    name: "MS ve 3.5 Alt/Üst",
    mtid: 272,
    sov: 3.5,
    outcomeMap: {
      1: "1 ve Alt", 2: "X ve Alt", 3: "2 ve Alt",
      4: "1 ve Üst", 5: "X ve Üst", 6: "2 ve Üst"
    }
  },
  {
    id: "ms_ve_4_5",
    category: CATEGORIES.MAC_SONUCU,
    name: "MS ve 4.5 Alt/Üst",
    mtid: 272,
    sov: 4.5,
    outcomeMap: {
      1: "1 ve Alt", 2: "X ve Alt", 3: "2 ve Alt",
      4: "1 ve Üst", 5: "X ve Üst", 6: "2 ve Üst"
    }
  },
  {
    id: "ms_ve_kg",
    category: CATEGORIES.MAC_SONUCU,
    name: "MS ve Karşılıklı Gol",
    mtid: 414,
    sov: 0.0,
    outcomeMap: {
      1: "1 ve Var", 2: "X ve Var", 3: "2 ve Var",
      4: "1 ve Yok", 5: "X ve Yok", 6: "2 ve Yok"
    }
  },
  {
    id: "ev_gol_yemeden_kazanir",
    category: CATEGORIES.MAC_SONUCU,
    name: "Ev Sahibi Gol Yemeden Kazanır",
    mtid: 589,
    sov: 0.0,
    outcomeMap: { 1: "Evet", 2: "Hayır" }
  },
  {
    id: "dep_gol_yemeden_kazanir",
    category: CATEGORIES.MAC_SONUCU,
    name: "Deplasman Gol Yemeden Kazanır",
    mtid: 590,
    sov: 0.0,
    outcomeMap: { 1: "Evet", 2: "Hayır" }
  },
  {
    id: "kac_farkla_kazanir",
    category: CATEGORIES.MAC_SONUCU,
    name: "Hangi Takım Kaç Farkla Kazanır?",
    mtid: 588,
    sov: 0.0,
    outcomeMap: {
      1: "Ev Sahibi 1 Fark", 2: "Ev Sahibi 2 Fark", 3: "Ev Sahibi 3+ Fark",
      4: "Beraberlik",
      5: "Deplasman 1 Fark", 6: "Deplasman 2 Fark", 7: "Deplasman 3+ Fark"
    }
  },

  // ==========================================
  // 2. YARI SONUCU
  // ==========================================
  {
    id: "iy_sonucu",
    category: CATEGORIES.YARI_SONUCU,
    name: "1. Yarı Sonucu",
    mtid: 7,
    sov: 0.0,
    outcomeMap: { 1: "1", 2: "X", 3: "2" }
  },
  {
    id: "iy_cifte_sans",
    category: CATEGORIES.YARI_SONUCU,
    name: "1. Yarı Çifte Şans",
    mtid: 8,
    sov: 0.0,
    outcomeMap: { 1: "1-X", 2: "1-2", 3: "X-2" }
  },
  {
    id: "iy_ve_iy_kg",
    category: CATEGORIES.YARI_SONUCU,
    name: "1. Yarı ve 1. Yarı KG",
    mtid: 416,
    sov: 0.0,
    outcomeMap: {
      1: "1 ve Var", 2: "X ve Var", 3: "2 ve Var",
      4: "1 ve Yok", 5: "X ve Yok", 6: "2 ve Yok"
    }
  },
  {
    id: "iy_1_5_alt_ust",
    category: CATEGORIES.YARI_SONUCU,
    name: "1. Yarı 1.5 Alt/Üst",
    mtid: 14,
    sov: 1.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "ikinci_yari_sonucu",
    category: CATEGORIES.YARI_SONUCU,
    name: "2. Yarı Sonucu",
    mtid: 9,
    sov: 0.0,
    outcomeMap: { 1: "1", 2: "X", 3: "2" }
  },
  {
    id: "ev_yari_kazanir",
    category: CATEGORIES.YARI_SONUCU,
    name: "Ev Sahibi Yarı Kazanır",
    mtid: 584,
    sov: 0.0,
    outcomeMap: { 1: "Evet", 2: "Hayır" }
  },
  {
    id: "dep_yari_kazanir",
    category: CATEGORIES.YARI_SONUCU,
    name: "Deplasman Yarı Kazanır",
    mtid: 585,
    sov: 0.0,
    outcomeMap: { 1: "Evet", 2: "Hayır" }
  },
  {
    id: "ev_iki_yariyi_da_kazanir",
    category: CATEGORIES.YARI_SONUCU,
    name: "Ev Sahibi İki Yarıyı da Kazanır",
    mtid: 591,
    sov: 0.0,
    outcomeMap: { 1: "Evet", 2: "Hayır" }
  },
  {
    id: "dep_iki_yariyi_da_kazanir",
    category: CATEGORIES.YARI_SONUCU,
    name: "Deplasman İki Yarıyı da Kazanır",
    mtid: 592,
    sov: 0.0,
    outcomeMap: { 1: "Evet", 2: "Hayır" }
  },

  // ==========================================
  // 3. MAÇ SONUCU ALT/ÜST
  // ==========================================
  {
    id: "alt_ust_1_5",
    category: CATEGORIES.MAC_SONUCU_ALT_UST,
    name: "1.5 Alt/Üst",
    mtid: 11,
    sov: 1.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "alt_ust_2_5",
    category: CATEGORIES.MAC_SONUCU_ALT_UST,
    name: "2.5 Alt/Üst",
    mtid: 12,
    sov: 2.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "alt_ust_3_5",
    category: CATEGORIES.MAC_SONUCU_ALT_UST,
    name: "3.5 Alt/Üst",
    mtid: 13,
    sov: 3.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "alt_ust_4_5",
    category: CATEGORIES.MAC_SONUCU_ALT_UST,
    name: "4.5 Alt/Üst",
    mtid: 155,
    sov: 4.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "alt_ust_5_5",
    category: CATEGORIES.MAC_SONUCU_ALT_UST,
    name: "5.5 Alt/Üst",
    mtid: 155,
    sov: 5.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "alt_ust_2_5_ve_kg",
    category: CATEGORIES.MAC_SONUCU_ALT_UST,
    name: "2.5 Alt/Üst ve Karşılıklı Gol",
    mtid: 446,
    sov: 2.5,
    outcomeMap: {
      1: "Üst ve Var", 2: "Üst ve Yok", 3: "Alt ve Var", 4: "Alt ve Yok"
    }
  },

  // ==========================================
  // 4. YARI ALT/ÜST
  // ==========================================
  {
    id: "iy_sonucu_ve_iy_1_5_alt_ust",
    category: CATEGORIES.YARI_ALT_UST,
    name: "1. Yarı ve 1. Yarı 1.5 Alt/Üst",
    mtid: 459,
    sov: 1.5,
    outcomeMap: {
      1: "1 ve Alt", 2: "X ve Alt", 3: "2 ve Alt",
      4: "1 ve Üst", 5: "X ve Üst", 6: "2 ve Üst"
    }
  },
  {
    id: "iy_0_5_alt_ust",
    category: CATEGORIES.YARI_ALT_UST,
    name: "1. Yarı 0.5 Alt/Üst",
    mtid: 209,
    sov: 0.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "iy_1_5_alt_ust_k4",
    category: CATEGORIES.YARI_ALT_UST,
    name: "1. Yarı 1.5 Alt/Üst",
    mtid: 14,
    sov: 1.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "iy_2_5_alt_ust",
    category: CATEGORIES.YARI_ALT_UST,
    name: "1. Yarı 2.5 Alt/Üst",
    mtid: 15,
    sov: 2.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "iki_yari_da_1_5_alt",
    category: CATEGORIES.YARI_ALT_UST,
    name: "İki Yarı da 1.5 Alt",
    mtid: [528, 279],
    sov: [0.0, 1.5],
    outcomeMap: { 1: "Evet", 2: "Hayır" }
  },
  {
    id: "iki_yari_da_1_5_ust",
    category: CATEGORIES.YARI_ALT_UST,
    name: "İki Yarı da 1.5 Üst",
    mtid: [529, 278],
    sov: [0.0, 1.5],
    outcomeMap: { 1: "Evet", 2: "Hayır" }
  },

  // ==========================================
  // 5. TARAF ALT/ÜST
  // ==========================================
  {
    id: "ev_0_5_alt_ust",
    category: CATEGORIES.TARAF_ALT_UST,
    name: "Ev Sahibi 0.5 Alt/Üst",
    mtid: 212,
    sov: 0.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "ev_1_5_alt_ust",
    category: CATEGORIES.TARAF_ALT_UST,
    name: "Ev Sahibi 1.5 Alt/Üst",
    mtid: 20,
    sov: 1.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "ev_2_5_alt_ust",
    category: CATEGORIES.TARAF_ALT_UST,
    name: "Ev Sahibi 2.5 Alt/Üst",
    mtid: [326, 320],
    sov: 2.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "ev_3_5_alt_ust",
    category: CATEGORIES.TARAF_ALT_UST,
    name: "Ev Sahibi 3.5 Alt/Üst",
    mtid: [327, 321],
    sov: 3.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "dep_0_5_alt_ust",
    category: CATEGORIES.TARAF_ALT_UST,
    name: "Deplasman 0.5 Alt/Üst",
    mtid: [256, 257],
    sov: 0.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "dep_1_5_alt_ust",
    category: CATEGORIES.TARAF_ALT_UST,
    name: "Deplasman 1.5 Alt/Üst",
    mtid: [29, 86],
    sov: 1.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "dep_2_5_alt_ust",
    category: CATEGORIES.TARAF_ALT_UST,
    name: "Deplasman 2.5 Alt/Üst",
    mtid: [328, 322],
    sov: 2.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "dep_3_5_alt_ust",
    category: CATEGORIES.TARAF_ALT_UST,
    name: "Deplasman 3.5 Alt/Üst",
    mtid: [329, 323],
    sov: 3.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "iy_ev_0_5_alt_ust",
    category: CATEGORIES.TARAF_ALT_UST,
    name: "1. Yarı Ev Sahibi 0.5 Alt/Üst",
    mtid: [455, 456],
    sov: 0.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },
  {
    id: "iy_dep_0_5_alt_ust",
    category: CATEGORIES.TARAF_ALT_UST,
    name: "1. Yarı Deplasman 0.5 Alt/Üst",
    mtid: [457, 458],
    sov: 0.5,
    outcomeMap: { 1: "Alt", 2: "Üst" }
  },

  // ==========================================
  // 6. GOL
  // ==========================================
  {
    id: "ilk_gol",
    category: CATEGORIES.GOL,
    name: "İlk Gol",
    mtid: [291, 682],
    sov: 0.0,
    outcomeMap: { 1: "1", 2: "Olmaz", 3: "2" }
  },
  {
    id: "iy_kg",
    category: CATEGORIES.GOL,
    name: "1. Yarı Karşılıklı Gol",
    mtid: [452, 453, 288],
    sov: 0.0,
    outcomeMap: { 1: "Var", 2: "Yok" }
  },
  {
    id: "ikinci_yari_kg",
    category: CATEGORIES.GOL,
    name: "2. Yarı Karşılıklı Gol",
    mtid: [599, 290],
    sov: 0.0,
    outcomeMap: { 1: "Var", 2: "Yok" }
  },
  {
    id: "kg",
    category: CATEGORIES.GOL,
    name: "Karşılıklı Gol",
    mtid: [38, 287],
    sov: 0.0,
    outcomeMap: { 1: "Var", 2: "Yok" }
  },
  {
    id: "ev_hangi_yarida_cok_gol",
    category: CATEGORIES.GOL,
    name: "Ev Sahibi Hangi Yarıda Daha Çok Gol Atar",
    mtid: 586,
    sov: 0.0,
    outcomeMap: { 1: "1.Y", 2: "Eşit", 3: "2.Y" }
  },
  {
    id: "dep_hangi_yarida_cok_gol",
    category: CATEGORIES.GOL,
    name: "Deplasman Hangi Yarıda Daha Çok Gol Atar",
    mtid: 587,
    sov: 0.0,
    outcomeMap: { 1: "1.Y", 2: "Eşit", 3: "2.Y" }
  },
  {
    id: "iy_2y_kg",
    category: CATEGORIES.GOL,
    name: "1. Yarı / 2. Yarı Karşılıklı Gol",
    mtid: 801,
    sov: 0.0,
    outcomeMap: {
      1: "Var / Var", 2: "Var / Yok", 3: "Yok / Var", 4: "Yok / Yok"
    }
  },
  {
    id: "ev_iki_yarida_da_gol",
    category: CATEGORIES.GOL,
    name: "Ev Sahibi İki Yarıda da Gol Atar",
    mtid: 295,
    sov: 0.0,
    outcomeMap: { 1: "Evet", 2: "Hayır" }
  },
  {
    id: "dep_iki_yarida_da_gol",
    category: CATEGORIES.GOL,
    name: "Deplasman İki Yarıda da Gol Atar",
    mtid: 296,
    sov: 0.0,
    outcomeMap: { 1: "Evet", 2: "Hayır" }
  },

  // ==========================================
  // 7. TOPLAM GOL
  // ==========================================
  {
    id: "toplam_gol_araligi",
    category: CATEGORIES.TOPLAM_GOL,
    name: "Toplam Gol Aralığı",
    mtid: 43,
    sov: 0.0,
    outcomeMap: { 1: "0-1 Gol", 2: "2-3 Gol", 3: "4-5 Gol", 4: "6+ Gol" }
  },
  {
    id: "en_cok_gol_olacak_yari",
    category: CATEGORIES.TOPLAM_GOL,
    name: "En Çok Gol Olacak Yarı",
    mtid: [48, 108],
    sov: 0.0,
    outcomeMap: { 1: "1.Y", 2: "Eşit", 3: "2.Y" }
  },
  {
    id: "tek_cift",
    category: CATEGORIES.TOPLAM_GOL,
    name: "Tek / Çift",
    mtid: [49, 109],
    sov: 0.0,
    outcomeMap: { 1: "Tek", 2: "Çift" }
  },
  {
    id: "iy_tek_cift",
    category: CATEGORIES.TOPLAM_GOL,
    name: "1. Yarı Tek / Çift",
    mtid: [450, 324],
    sov: 0.0,
    outcomeMap: { 1: "Tek", 2: "Çift" }
  },

  // ==========================================
  // 8. MAÇ SKORU
  // ==========================================
  {
    id: "iy_ms_skor",
    category: CATEGORIES.MAC_SKORU,
    name: "İlk Yarı / Maç Skoru",
    mtid: 571,
    sov: 0.0,
    dynamicOutcomes: true
  },
  {
    id: "iy_skoru",
    category: CATEGORIES.MAC_SKORU,
    name: "1. Yarı Skoru",
    mtid: [779, 780, 783, 276, 448],
    sov: 0.0,
    dynamicOutcomes: true
  },
  {
    id: "mac_skoru",
    category: CATEGORIES.MAC_SKORU,
    name: "Maç Skoru",
    mtid: [777, 775, 776, 778, 205, 275],
    sov: 0.0,
    dynamicOutcomes: true
  }
];
