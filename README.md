# Nesine Maç Oranları Çekici (Chrome Extension - Manifest V3)

Bu Chrome eklentisi, kullanıcının girdiği futbol karşılaşmasının ev sahibi ve deplasman takımlarına göre Nesine bültenindeki ilgili maçı bulur ve 8 ana kategori altındaki 40'tan fazla bahis pazarına ait oranları otomatik olarak çekerek modern, kategorilere ayrılmış bir arayüzde sunar.

---

## 🚀 Özellikler

1. **Akıllı Takım Eşleştirme Motoru:**
   * Türkçe karakter duyarsızlığı (`ı/i, ğ/g, ü/u, ş/s, ö/o, ç/c`).
   * Büyük/küçük harf toleransı.
   * Kulüp eklerini ve kısaltmalarını otomatik temizleme (`FC, SK, FK, AFC, AS, Utd, United, City vb.`).
   * Hibrit Levenshtein & Jaccard token benzerliği.
   * Yanlış maçları önlemek için hem ev sahibi hem deplasman takımını birlikte doğrulama.
2. **Yüksek Hızlı ve Kararlı Veri Çekme:**
   * Kırılgan CSS/DOM kazıma yerine, Nesine'nin arka planda kullandığı yüksek hızlı açık CDN bülten API'sini (`cdnbulten.nesine.com`) doğrudan kullanır.
   * Virtual scroll veya ekran dışı pazar eksikliklerinden etkilenmez.
3. **8 Ana Bahis Kategorisi:**
   * **1. MAÇ SONUCU:** Maç Sonucu, Çifte Şans, Handikaplı Maç Sonuçları (0:2, 0:1, 1:0, 2:0), İY/MS, MS & Alt/Üst (1.5, 2.5, 3.5, 4.5), MS & KG, vb.
   * **2. YARI SONUCU:** 1. Yarı Sonucu, 1. Yarı Çifte Şans, 1. Yarı Sonucu & KG, 1. Yarı 1.5 Alt/Üst, 2. Yarı Sonucu, Yarı Kazanma Pazarları.
   * **3. MAÇ SONUCU ALT/ÜST:** 1.5, 2.5, 3.5, 4.5, 5.5 Alt/Üst ve 2.5 Alt/Üst & KG.
   * **4. YARI ALT/ÜST:** 1. Yarı 0.5, 1.5, 2.5 Alt/Üst ve İki Yarı da 1.5 Alt/Üst (Evet/Hayır).
   * **5. TARAF ALT/ÜST:** Ev Sahibi ve Deplasman 0.5, 1.5, 2.5, 3.5 Alt/Üst ve 1. Yarı Taraf Alt/Üst baremleri.
   * **6. GOL:** İlk Gol, Karşılıklı Gol, 1. Yarı KG, 2. Yarı KG, 1.Y/2.Y KG, Taraf Gol Yarıları.
   * **7. TOPLAM GOL:** Toplam Gol Aralığı (0-1, 2-3, 4-5, 6+), En Çok Gol Olacak Yarı, Tek/Çift.
   * **8. MAÇ SKORU:** İlk Yarı / Maç Skoru, 1. Yarı Skoru, Maç Skoru (1:0, 2:1, diğer vb.).
4. **Oran Bütünlüğü ve Filtreleme:**
   * Kilitli (`0.0`, `1.00`), boş, `-` veya kapalı bahisler kesinlikle listelenmez.
   * Pazar bulunamadığında uygulama durmaz, mevcut pazarları göstermeye devam eder.
5. **Kopyalama Desteği:**
   * "Tüm Oranları Kopyala" butonu ile her seçim tek satırda olacak şekilde panoya aktarılır.
6. **Debug Konsolu:**
   * Popup üzerinde açılıp kapanabilir canlı konsol logları (`[MatchFinder]`, `[MarketParser]`).

---

## 📦 Kurulum (Chrome'a Yükleme)

1. Google Chrome tarayıcınızı açın.
2. Adres çubuğuna `chrome://extensions/` yazın ve Enter'a basın.
3. Sağ üst köşedeki **"Geliştirici modu" (Developer mode)** anahtarını açık konuma getirin.
4. Sol üstte beliren **"Paketlenmemiş öğe yükle" (Load unpacked)** butonuna tıklayın.
5. Bu projenin içindeki **extension** klasörünü (`/Users/teddybear/macoranverisi/extension`) seçin.
6. Eklenti simgesi araç çubuğuna eklenecektir.

---

## 🧪 Testleri Çalıştırma

Projede bulunan otomatik test paketini çalıştırmak için terminalde şu komutu çalıştırabilirsiniz:

```bash
cd extension
node tests/test_suite.js
```
