# Lokal kod oran aralığı doğrulaması — 2026-10-23

Bu özellik yalnız lokal çalışma klasöründe uygulandı. Sunucuya yükleme, push veya canlı yayın yapılmadı. PNG ve mevcut tüm-oranları-kopyalama içeriğine sınıflandırma eklenmedi.

## Davranış

Normal süre Maç Sonucu 1/X/2 değerlerinden favori ve B0–B7 bandı belirlenir. Eşitlikte iki kod; kapalı seçeneklerde kullanıcının ≤1.50 ve >7.00 kuralları uygulanır. Eksik/bozuk/çelişkili veri kod üretmez. MSX favoriyi belirlemez. Hesaplama GPT çağrısı olmadan yapılır.

API yanıtındaki ek `matchResultOdds` alanı `{version: 1, sets: [...]}` biçimindedir; her set MS1/MSX/MS2 için `open`, `closed`, `missing`, `invalid` durumunu ve orijinal ondalık değeri taşır. `bandClassification` alanı `status`, `band`, `codes`, `odds`, `lines` içerir. Sınıflandırma durumları `classified`, `unavailable`, `unclassified`, `suspicious`, `conflict` olabilir. Yeni metadata doğrulanmış arşivle saklanır; eski kayıtlardan yuvarlama öncesi hassasiyet veya kapalı durumu uydurulmaz ve sırf sınıflandırma için ek sorgu yapılmaz.

## Otomatik ve tarayıcı kontrolleri

- Node.js v24.22.0: `npm run test:historical` — 232 test geçti (önceki 218 + yeni 14).
- Yeni testler tüm bant sınırlarını, uzun ondalık hassasiyetini, eşitliği, MSX bağımsızlığını, kapalı/eksik/şüpheli oranları, çoklu set çelişkisini, sağlayıcı doğrulamasını, gerçek ayrıştırıcı aktarımını ve eski/yeni önbellek davranışını kapsar.
- Frontend `npm run lint` başarılı: önceden bulunan üç `aiExportRenderer.js` unused-parameter ve bir `MatchSearch.jsx` effect uyarısı sürer; yeni uyarı yok.
- Frontend `npm run build` başarılı; yerel API kullanır.
- `web/tests/browser/matchBand.mjs`: localhost üzerindeki gerçek React uygulamasında kontrollü API örnekleriyle 320, 390, 768, 1280 px × default/black/white = 12 görünüm. Yatay görünüm alanı taşması bulunmadı. Tema menüsünde gerçek klavye seçimi, hover/Escape ve Chrome dokunmatik emülasyonu kontrol edildi.
- Aynı tarayıcı kontrolü: oran bulunamayan ekranda açıklama, tarihsel satır seçilince kodun değişmesi, H2H kaynağı/kaydırması ve istek sayısının korunması, Temizle odağı, geç yanıtın reddi ve sonraki arama doğrulandı. Panoya kopyalanan metin sınıflandırma içermiyor.
- Ekran görüntüleri işletim sisteminin geçici dizinindeki `oran-band-ui/` klasörüne yazılır; örnek 320/default, 390/black ve 1280/white görselleri incelendi. Fiziksel dokunmatik cihaz testi yapılmadı. PNG akışı değiştirilmedi ve bu turda tekrar indirilmedi.

Tarayıcı kontrolünü tekrarlamak için frontend derlemesinden sonra:

```sh
CHROME_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node web/tests/browser/matchBand.mjs
```

## Gerçek sağlayıcı verisiyle lokal sorgular

| Lokal API sorgusu | MS1 · MSX · MS2 | Sonuç |
| --- | --- | --- |
| CSD Imperial – CD Marquense, güncel Nesine | 1.4 · 3.38 · 4.53 | B2 aralığında Evb2 |
| Den Haag – PSV, 2026-10-17, Maçkolik | 7.17 · 5.57 · 1.15 | B0 aralığında Depb0 |
| Den Haag – PSV, 2026-10-17, Sahadan | 7.17 · 5.57 · 1.15 | B0 aralığında Depb0 |

Bu sonuçlar doğrulama anındaki verilerdir; sonraki sağlayıcı erişimini veya oranların sabit kalacağını garanti etmez. Canlı VDS API'si ve yayımlanmış iki site bu işlem kapsamında değiştirilmedi veya doğrulanmadı.

Bağımsız kod incelemesinde bulunan yinelenen etiket ve gizli HTML oranı durumları yeniden üretildi, düzeltildi ve regresyon testlerine eklendi. Çalışma kullanıcı testi için yerel dosyalarda bırakıldı.
