# Bant sınıflandırması canlı yayın doğrulaması — 2026-10-23

Uygulama commit'i: `3b235aad83f666ebae54567bc3e2316e25752379`.
Kullanıcı lokal testi doğru bulduktan sonra GitHub, VDS, Netlify ve GitHub Pages yayınına açıkça izin verdi. Önceki lokal-only karar bu yayın için kullanıcı tarafından değiştirildi. Kimlik doğrulama bilgileri kaydedilmedi.

## Eski arşivler ve testler

Yayın öncesi üretimde159 kayıtlı arşivin tamamında yeni MS snapshot'ı yoktu. Kullanıcının seçimiyle kayıtlar topluca taranmaz; eski oranlı arşiv ilk okununca sabit kimlik/tarih/kaynakla tamamlanır. Geçerli yeni arşiv ve MS verisi olmadan eski kayıt değiştirilmez. Hata halinde kayıtlı oranlar ve açıklama döner; tekrar denemesi en az15 dakika veya daha uzun Retry-After süresi kadar ertelenir. Bekleme kaydı kalıcıdır; yazma hatasında aynı süreç içindeki bellek sınırı korumaya devam eder. Ortak maç yenilemesi birleştirilir; toplam isteğin bitimine1 saniye kala yeni sağlayıcı isteği başlatılmaz.

- Yerel ve VDS test ortamında239/239 test geçti. Önceki232 teste7 arşiv tamamlama testi eklendi.
- Bağımsız incelemede bulunan disk-yazma hatası ve dış zaman aşımı yarışı, önce başarısız regresyonlarla yeniden üretildi ve düzeltildi.
- Yerel/VDS lint başarılı; önceden bulunan4 uyarı sürüyor. İki ortamda frontend derlemesi başarılı.
- Yerel opt-in browser testi12 genişlik/tema birleşiminde, klavye/hover/dokunmatik emülasyonu ve istek yaşam döngüsü kontrolleriyle geçti.

## VDS yayını ve geri dönüş

- Önce GitHub yayın dalı gönderildi; main, backend doğrulanana kadar ilerletilmedi.
- `/opt/oran-analiz-band-stage`, loopback3001 ve ayrı `/var/lib/oran-analiz-band-stage` ile test edildi. Üretim veri tabanına test sorguları uygulanmadı.
- Test ortamında Den Haag/PSV, 2026-10-17, `amb531b6gw4qltbvmqqsrauxg` arşivi iki sağlayıcı için ilk okumada tamamlandı. Maçkolik47, Sahadan78 pazar; her ikisinde MS1 7.17 · MSX 5.57 · MS2 1.15 → Depb0. İkinci okuma ve test servisi yeniden başladıktan sonraki okuma kalıcı önbellekten geldi.
- Üretim terfisinden hemen önce ikinci SQLite çevrimiçi yedeği alındı. İki yedekte `quick_check=ok` doğrulandı; dosyalar özel izinlerle saklandı.
- Terfi gerçek dizin taşımasıyla yapıldı. Önceki kod: `/opt/oran-analiz-pro-before-bands-3b235aa-20261023T195537Z`.
- Terfi öncesi yedek: `/var/backups/oran-analiz/release-match-bands-2026-10-23T19-55-38.044Z.sqlite`. İlk test hazırlığı yedeği: `/var/backups/oran-analiz/before-match-bands-2026-10-23T19-52-01.132Z.sqlite`.
- Üretim veri yolu `/var/lib/oran-analiz` korundu. Üretim ve dış HTTPS sağlık kontrolü başarılı; denetim zamanlayıcısı yeniden etkin, geçici test servisi durduruldu. Terfi betiğinin başarısızlık halinde önceki kodu geri getirme koruması vardı; geri dönüş gerekmedi.
- Üretimde de iki Den Haag/PSV kaydı ayrı ayrı tamamlandı ve Depb0 döndü; güncel CSD Imperial/CD Marquense18 pazar ile MS1 1.4 · MSX 3.38 · MS2 4.53 → Evb2 döndü. Den Haag/PSV H2H10 satır verdi. Dış HTTPS seçili arşiv sorgusu200 ve Depb0 döndürdü.

## İki frontend

- Netlify: `https://oran-analiz-pro.netlify.app`, deploy `6adbbbecba492e132419256d`, kaynak commit3b235aa; resmi API'de ready.
- GitHub Pages: `https://ahmedyesovic.github.io/oran-analiz-pro/`, [workflow40015338449](https://github.com/ahmedyesovic/oran-analiz-pro/actions/runs/40015338449) başarılı.
- İkisinin yayımladığı dosyalar `index-D5gkqYi7.js` ve `index-CPkqiRO2.css`; ortak API mevcut VDS HTTPS adresi. Yerel dist localhost/aynı-origin ayarını korur.
- Canlı Chrome'da Den Haag/PSV girdisi Netlify ve Pages üzerinde Maçkolik oranları ve Depb0 gösterdi;10 H2H satırı korundu. İki sitede tarihsel ilk satır seçildi; bant ve H2H kaynak sayfası korundu.
- İki sitede Sahadan seçimi de Depb0 gösterdi. Temizle oran/bant/H2H'yi kaldırdı, odağı ev alanına döndürdü ve seçili Sahadan kaynağını korudu. Pages'te ardından CSD Imperial/CD Marquense yeni araması Evb2 ve10 H2H satırı gösterdi.
- Pages canlı görünüm örnekleri:390/default,390/black,320/black,768/white,1280/default. Yeni bant kartı okunuyor;320 px'te metin satırlara sarılıyor.1280 px'te H2H sağda, küçük genişliklerde altta. Netlify masaüstü akışı kontrol edildi. Canlı iki site için tam12×2 tema/genişlik matrisi, fiziksel dokunmatik ve tüm-kategori PNG tekrar sınanmadı; yerel12 birleşim testiyle karıştırılmamalı.
- Netlify Maçkolik tek kategori PNG:2400×3680,500541 bayt. Pages Sahadan tek kategori PNG:2400×4378,613527 bayt; görünümü incelendi. PNG'ye bant bilgisi eklenmedi. Gerçek üretim yanıtından pano biçimlendiricisi4289 karakter üretti ve Evb/Depb/bant açıklaması içermedi.

Bu doğrulamalar belirtilen sorguların o andaki durumudur.159 kayıt önceden topluca tamamlanmadı; kalan eski arşivler kullanıcı aradıkça tamamlanır ve kaynak erişimine bağlıdır. Netlify otomatik yayını başarılı olduğundan ayrıca hesap girişi gerekmedi.
