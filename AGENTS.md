# Repository Guidelines

## Project Structure & Module Organization

- `web/server.js` provides the Express API and serves the frontend.
- `web/src/` contains match lookup, historical resolution, scraping, parsing, and categorization.
- `web/tests/` contains deterministic historical-resolution, Sahadan H2H, request-lifecycle, and theme tests; source HTML samples live in `web/tests/fixtures/`.
- `web/frontend/` is the React/Vite UI; `web/public/` is the legacy UI.
- `web/frontend/src/utils/matchRequests.js` coordinates independent odds and H2H requests; `web/frontend/src/utils/theme.js` and `web/frontend/src/components/ThemeSelector.jsx` manage frontend themes.
- Keep team-name behavior aligned between `utils/normalize.js` and `extension/utils/normalize.js`.
- `extension/` is the Manifest V3 Chrome extension; runtime code is under `background/`, `content/`, `popup/`, and `utils/`.

## Architecture Notes

Default lookup checks the current Nesine bulletin, recent results, then Mackolik. Historical events preserve `HTTR`/`ATTR` aliases. Without a Nesine date, `MackolikScraper` scans seven daily feeds before web-search fallback. Preserve this order, accept only verified Nesine odds, and add aliases through the shared matcher rather than one-off replacements.

- A selected historical row supplies `matchId`, teams, and date. Open that match directly and verify its identity, teams, date, and completed result instead of rediscovering it through search. Preserve this behavior for both Mackolik and Sahadan.
- A verified old match may have no odds archive. For Sahadan, a missing Iddaa code or an odds-endpoint HTTP 404 means unavailable odds, while retaining the verified match result. Do not turn missing match details, malformed responses, timeouts, or other provider failures into a successful empty result.

### Sahadan Head-to-Head Data

- `/api/head-to-head?home&away` always uses Sahadan, independently of the selected historical odds source. `SahadanScraper` and `sahadanParser.js` scrape the initially rendered **Aralarındaki Maçlar** HTML table from `/mac/{slug}/{id}/karsilastirma`.
- Team schedules and Nuxt data discover and verify the source match; they must not supply or expand the displayed rows. Do not merge hidden history, activate **Tümünü Göster**, impose a ten-row cap, or restore the removed hardcoded old-match exclusions.
- Choose a matching live (`Playing`) source match first, otherwise the nearest future `Fixture`, otherwise the latest completed `Played` match. Accept either team order through the shared matcher without confusing youth, reserve, or women's teams.
- Preserve source row order, teams, full-time and half-time scores, and calendar dates. Convert displayed `DD.MM.YYYY` dates to ISO dates without timezone shifts or invented kickoff times. Validate row links and reject malformed tables rather than silently dropping rows.
- Return actual `count`, per-row `halfTimeScore`, and `sourceUrl`, `sourceMatchId`, `sourceMatchDate` provenance. Keep a valid empty table distinct from missing comparison pages and parsing/transport failures.

## Frontend Behavior

- The search form has no optional date input. Historical row selection still sends its date and stable match ID.
- Keep **Oranları Bul** and **Temizle** together with equal width and 50 px height; the group may wrap below the fields, but the buttons stay side by side on mobile.
- **Temizle** clears team fields, odds, H2H, errors, loading states, and selection; aborts both request types; and ignores late replies. Preserve the chosen odds source and theme, return focus to the home-team field, and allow a new search afterward.
- The H2H panel sits on the right at desktop widths of at least 1100 px and below the main content on smaller screens. Keep readable match rows with the date above team names, aligned full-time/half-time score columns, full-row buttons, and a visible selected state.
- Selecting a historical row updates only the odds request and selected indicator. Preserve the original H2H data, source page, and scroll position. A new team-pair search must clear the previous pair's table and ignore stale responses.
- In `MatchResult`, hide **KORNER & KART** and its markets only when `isHistorical === true`. Use the filtered categories for rendering and PNG exports; historical clipboard formatting must not restore hidden odds through the `formattedMarkets` fallback. If no categories remain, show **Gösterilecek oran bulunmuyor.** and disable copy/download actions. Preserve current-match behavior and initialize the first visible category as open. Keep React hooks unconditional.

### Themes

- Support `default` (**Varsayılan tema**, existing navy appearance), `black` (**Siyah tema**), and `white` (**Beyaz tema**), in that menu order. Apply themes through the root HTML `data-theme` attribute and shared CSS variables; avoid fixed UI colors outside palette definitions and intentional theme swatches.
- The top-right **Tema** menu opens on mouse hover and supports touch/click and keyboard navigation. Preserve selected-option indicators, arrow-key navigation, outside-click/blur dismissal, and Escape closing with focus returned to the trigger.
- Store the preference under `oran-analiz-theme` in `localStorage`. Keep the pre-paint bootstrap in `web/frontend/index.html` aligned with the supported values in `web/frontend/src/utils/theme.js`. Missing/invalid preferences fall back to `default`; blocked storage must not prevent changing the current page's theme.
- Colored background animations belong only to the default theme. Theme changes must not reset searches, results, selected matches, or H2H scroll position. PNG exports retain their independent white design.

## Build, Test, and Development Commands

Run from the repository root unless noted:

```bash
npm install                         # Install server dependencies
npm run test:historical             # Run all web/tests/*.test.js regression tests
npm run build                       # Build the React frontend into web/frontend/dist
npm start                           # Start the Express server (usually port 3000)
cd web/frontend && npm run dev      # Start the Vite development server
cd web/frontend && npm run lint     # Run frontend lint checks
cd extension && node tests/test_suite.js
cd extension && node tests/test_ai_export.js
```

The extension integration suite uses live Nesine data and requires network access.

## Coding Style & Naming Conventions

Use ES modules, 4-space indentation, and semicolons in backend/extension JavaScript. Use `camelCase` for values, `PascalCase` for components/classes, and kebab-case asset paths. Keep market names and API mappings consistent with existing modules.

## Testing Guidelines

Node's built-in runner provides regression coverage; there is no coverage gate. `npm run test:historical` runs all `web/tests/*.test.js`, not just historical lookup tests:

- `historicalResolution.test.js`: aliases, daily-feed discovery, direct historical identity checks, unavailable archives, and false-positive protection.
- `sahadanH2h.test.js`: source selection, exact initial HTML rows, dates/scores, provenance, malformed tables, and provider failures. Keep Genoa–Como and Arsenal–Chelsea fixtures as deterministic source examples.
- `matchRequests.test.js`: independent odds/H2H lifetimes, stable history selection, clearing, cancellation, late responses, and subsequent searches.
- `theme.test.js`: supported preferences, persistence, blocked storage, and pre-paint bootstrap consistency.

After lookup changes, run the regression suite and a live query. For UI changes, run lint, build, and inspect the page. Check themes and responsive behavior at 320, 390, 768, and 1280 px, including menu hover/touch/keyboard operation. If browser tooling is unavailable, report the visual verification gap explicitly; static rendering and passing tests do not establish that mobile interaction or layout is correct.

## Commit, Pull Request & Deployment Guidelines

Use short imperative subjects, such as `Harden historical match lookup`. Pull requests must describe behavior, affected areas, and test results; include screenshots for UI work. Keep `netlify.toml` and `.github/workflows/` synchronized. GitHub Pages and Netlify use the VDS API at `https://oran-api.185-23-75-42.sslip.io` through `VITE_API_BASE_URL`; GitHub Actions reads the repository variable `API_BASE_URL`. The API runs on Ubuntu under the `oran-analiz` systemd service behind Caddy with automatic HTTPS, with its application checkout at `/opt/oran-analiz-pro`. The previous Render service `srv-dadmhlgn74is73amq40g` (`oran-analiz-pro`) was deleted at the user's request on 2026-10-19. The current VDS subscription expires in approximately three months; a replacement Render service can be created then. Keep deployment configuration available: repository `ahmedyesovic/oran-analiz-pro`, branch `main`, Node runtime, root directory blank, build command `npm install && npm run build`, start command `npm start`, health check `/api/health`. After creating a replacement, update both `netlify.toml` and GitHub repository variable `API_BASE_URL` to its new HTTPS URL and republish both frontends; the old service URL must not be assumed reusable. There is intentionally no `render.yaml`.

## Security & Reliability

Never commit credentials or tokens. Treat scraped data and provider endpoints as fallible: retain timeouts, validation, deterministic daily-feed lookup, and clear fallback logging.

## Verification Snapshot — 2026-10-19

This is the latest recorded local verification, not a permanent test-count requirement or evidence of deployment. Refresh it when new checks are performed.

- 56 automated tests passed with `npm run test:historical` on standalone Node.js v24.22.0. New coverage includes provider cooldown/recovery, Retry-After formats, malformed Mackolik daily feeds, and trying later candidates after an individual request fails.
- Live local Roma–Genoa Sahadan H2H discovery returned 10 rows. A Mackolik daily-feed query for Roma–Genoa on 2025-01-17 returned one candidate. These checks do not establish odds-archive availability or access from Render.
- The production Render endpoints returned provider HTTP 429 responses during the investigation. Backend commit `d8cafdc` was subsequently deployed to Render, where the rate limit remained.
- The same backend was installed on the VDS with Node.js v24.22.0, automatic systemd startup and HTTPS. All 56 tests passed on the VDS. An external HTTPS Betis–Barcelona pair search returned 51 verified Nesine markets for 2026-10-17; Sahadan H2H returned 10 initial-table rows. These checks establish access for these queries at verification time, not guaranteed future provider access.
- The production frontend build with the VDS API URL succeeded. GitHub Pages and Netlify published configuration commit `6463c2d`; their live Chrome sessions both sent searches to the VDS, received 51 Betis–Barcelona markets and 10 H2H rows, and generated a valid 2400 × 3652 PNG (484,008 bytes). A desktop result screenshot was inspected at 1280 px. Frontend component code did not change; lint, mobile layouts, theme interactions, and all-category exports were not rechecked. The earlier UI verification and its limitations are recorded below.
- A follow-up live Netlify audit found odds and valid single-category PNGs for Real Madrid–Sevilla (50 markets), Bayer Leverkusen–Freiburg (51), Manchester City–Ipswich Town (49), Roma–Genoa (51), and Strasbourg–PSG (50). No HTTP 429 occurred during these checks. Intermittent Sahadan HTTP 502 responses for Madrid and Roma recovered on a single manual retry, returning 10 rows each.
- Matching audit findings before the alias fix: Valencia–Athletic Bilbao initial odds lookup returned 404; its H2H lookup incorrectly accepted the women's teams `Valencia (K)` / `A. Bilbao (K)`. Manchester City–Ipswich H2H discovery selected `Manchester City Res.` and received HTTP 404. Provider search results showed that `Ath. Bilbao` and `Man. City` were rejected by the shared matcher, while `(K)` and `Res.` qualifiers were not protected by `sameTeam`. These results must not be treated as fully successful pair resolution.

- Matching fix verification: all 65 automated regression tests passed locally. The shared web/extension matcher accepts `Man. City` and `Ath. Bilbao`, separates women/reserve/youth squads, and preserves prefix initials, compact names and acronyms. Live local queries returned 51 Valencia–Athletic Bilbao markets and 49 Manchester City–Ipswich markets, with 10 correct main-team H2H rows each. Backend commit `b5f162b` was deployed to the VDS; all 65 tests also passed there. A fresh live Netlify Chrome audit resolved all six pairs (Madrid, Leverkusen, City, Valencia, Roma, Strasbourg), each with 10 H2H rows and a valid 2400 × 3652 single-category PNG. Valencia and City source rows were checked to belong to the main teams. No HTTP 429/502 occurred in this audit. The Valencia desktop screenshot was inspected; mobile/theme interactions and all-category export were not rechecked. GitHub Pages published `b5f162b`; Netlify retains its unchanged frontend build and uses the updated shared VDS API. Fresh GitHub Pages Chrome checks also returned 49 City markets, 51 Valencia markets, 10 H2H rows each and valid single-category PNGs.
- The standalone extension suites remain blocked by existing imports: `test_suite.js` imports missing `evaluateMatchMatch`, and `test_ai_export.js` imports missing `utils/marketDefinitions.js`. The web regression suite directly checks the extension matcher.

- Follow-up reported spelling `Real Madrid` / `Sevillia` reproduced Mackolik match-not-found and Sahadan HTTP 404, while `Sevilla` resolved correctly. Added the explicit `Sevillia` → `Sevilla` alias in both shared matchers, preserving squad identity and rejecting Sevilla Atletico. All 70 automated tests passed locally and on the VDS, including five new spelling/discovery regressions. Backend commit `368a80a` was deployed. A fresh Netlify Chrome search using the exact reported `Real Madrid` / `Sevillia` inputs returned HTTP 200, 50 verified markets and 10 Sahadan H2H rows, resolving both reproduced errors. Its single-category PNG was valid (2400 × 3652, 488,728 bytes). Frontend components were unchanged; responsive/theme interactions and all-category export were not rechecked.

- Follow-up exact input `Valencia` / `Athletico Bilbao` reproduced missing Sahadan comparison and Mackolik historical-match errors. Added this spelling as an explicit shared alias for Athletic Bilbao, retaining squad identity and Atlético Madrid rejection. All 72 automated tests passed locally and on the VDS, including exact-input discovery and H2H parsing coverage. Backend commit `8e3af1f` was deployed. A fresh Netlify Chrome search using the exact reported input with Mackolik selected returned 51 verified markets and 10 Sahadan H2H rows (both HTTP 200). With Sahadan selected, the same exact-input search returned 93 verified markets (HTTP 200) and the same 10 H2H rows (browser-cache revalidation HTTP 304). Both source selections generated valid single-category PNGs (Mackolik 2400 × 3652; Sahadan 2400 × 4346). Frontend components were unchanged; responsive/theme interactions and all-category export were not rechecked.

- Follow-up exact input `Den Haag` / `PSV` reproduced Mackolik match-not-found (HTTP 404), while `Den Haag` / `PSV Eindhoven` returned 47 verified Nesine markets for 2026-10-17. The daily feed uses `Den Haag` / `PSV`; the odds archive uses `ADO Den Haag` / `PSV Eindhoven`. Added the explicit `PSV` / `PSV Eindhoven` alias in both shared matchers, retaining Jong PSV, FC Eindhoven and squad separation. New regression assertions failed before the fix; all 74 tests passed locally and on the VDS afterward. The user requested the change directly on the VDS; files were backed up, patched and tested there before restarting the service. Commit `e78479e` records the same application/test changes on GitHub. External HTTPS verification with the exact input returned HTTP 200 and 47 markets; Chrome searches on both live sites displayed the correct archive and 10 Sahadan H2H rows. The first Netlify H2H request reported a provider connection failure; a single subsequent API request returned HTTP 200 with 10 rows, and repeating the Netlify search displayed those rows. Frontend code, responsive/theme interactions and PNG exports were not changed or rechecked.

### Earlier Verification — 2026-09-08

- 45 automated tests passed; the production frontend build with the Render API URL succeeded. Lint exited successfully with four warnings: three unused callback parameters in `aiExportRenderer.js` and the selection-sync effect in `MatchSearch.jsx`.
- A live local Genoa–Como H2H query succeeded with 10 rows, half-time scores, and Sahadan provenance. The earlier 2026-09-05 checks compared Genoa–Como and Arsenal–Chelsea rows with their source HTML. Provider requests can intermittently return HTTP 429/502.
- The search form was visually inspected in Chrome at 320, 390, 768, and 1280 px, including default, black, and white themes and keyboard theme selection. No horizontal overflow was observed in the empty search form; the 390 px action buttons measured equal widths and 50 px heights. Full result/export layout, touch, and hover interaction coverage remains incomplete.
- These checks were performed before the requested GitHub and Netlify publication; this snapshot alone is not evidence of deployment.


## Güncel Durum — 2026-10-19

Bu bölüm, bu sohbetteki kullanıcı taleplerinin tamamını, yapılan işlemleri, verilen yanıtların içeriğini ve son doğrulanan durumu birlikte kaydeder. Eski asistan yanıtlarının kelimesi kelimesine metni mevcut bağlamda bulunmadığından bu bir birebir dışa aktarım değil, konuşmanın kapsamlı kaydıdır. Sunucu parolası ve diğer kimlik doğrulama bilgileri kayda dahil edilmemiştir. Aşağıdaki sonuçlar belirtilen kontrollerin yapıldığı andaki durumu gösterir; sağlayıcılara gelecekte kesintisiz erişim garantisi vermez.

### Sohbet kaydı ve alınan kararlar

1. **Proje yönergeleri:** Kullanıcı “bu projedeki AGENTS.MD dosyasını oku” dedi. Proje yönergeleri okundu. Daha sonra kullanıcı AGENTS.md içeriğini ve çalışma ortamını da paylaştı. Bu dosyadaki mimari, test, arayüz, tema ve güvenlik kuralları esas alındı.

2. **İlk hata bildirimi:** Kullanıcı `https://oran-analiz-pro.netlify.app` ve `https://ahmedyesovic.github.io/oran-analiz-pro/` sitelerinde Real Madrid–Sevillia, Bayer Leverkusen–Freiburg, City–Ipswich, Real Betis–Barcelona, Valencia–Athletico Bilbao, Roma–Genoa ve Strasbourg–PSG maçlarının oran görsellerini almaya çalışırken HTTP 429 ve “mackolik: istenen geçmiş maç bulunamadı” hataları aldığını bildirdi. Roma ve Strasbourg için Sahadan HTTP 429 da bildirildi. Bu hata türlerinin tamamının tek nedenden kaynaklanmadığı sonradan doğrulandı: sağlayıcı istek sınırı, geçici sağlayıcı hataları ve takım adı eşleştirmesi ayrı sorunlardı.

3. **Yetkilendirme ve çalışma ortamı:** Kullanıcı “onaylıyorum”, ardından “r studio neden giriyorsun?” ve “o zaman node.js kur” dedi. Çalışmalar bağımsız Node.js kurulumu üzerinden sürdürüldü. Yerelde ve VDS'de kullanılan doğrulanmış sürüm Node.js v24.22.0 oldu. Kullanıcı “Değişiklikleri canlı sitelere yayınla” diyerek yayınlamayı da istedi.

4. **Real Betis–Barcelona ve Maçkolik:** Kullanıcı bu maçı yazıp **Oranları Bul** butonuna bastığında “mackolik: HTTP 429 — kaynak istekleri sınırlandırdı. 60 saniye bekleyin.” hatası aldığını, Maçkolik'in seçili olduğunu belirtti. Kullanıcı “nasıl bir yol izlememiz gerekiyor?” diye sordu. Sağlayıcı yanıtları, Render erişimi ve sunucu alternatifi araştırıldı.

5. **HTTP hata yönetimi:** `sourceHttp.js` üzerinde sağlayıcı bazında 429 bekleme süresi, sayısal ve tarih biçimli `Retry-After` desteği ve geçersiz başlıkta varsayılan 60 saniye davranışı uygulandı. API uygun 503 ve `Retry-After` yanıtını korur; uygun önbellek sonucu varsa kullanılabilir. Taşıma ve bozuk sağlayıcı yanıtları “maç bulunamadı” sonucuna gizlenmez. Mackolik günlük akışlarının şeması ve maç kimlikleri doğrulanır. Bir aday başarısız olduğunda sonraki adaylar denenebilir; bütün adaylar başarısızsa kaynak hatası korunur. Bu aşamada 56 otomatik test geçti. Render'a dağıtım yapılmasına rağmen Render üzerinden sağlayıcı 429 yanıtları devam etti.

6. **Ücretsiz barındırma arayışı:** Kullanıcı “bana render tarzı ücretsiz olanları listele” dedi; alternatifler değerlendirildi. Ardından “Northflank deneyelim ilk önce” ve “Developer Sandbox seçili” dedi. Northflank denemesi yapıldı; ödeme yöntemi gerektiren engel nedeniyle yeni çalışan servis kurulmadı. Kullanıcının kendi VDS'sini kullanma kararıyla bu deneme bırakıldı.

7. **Kullanıcının VDS'si:** Kullanıcı “bende sunucu var 3 aylık sunucu ona kurarmıyız?” dedi ve şu bilgileri paylaştı: ana bilgisayar adı `azarbayram0`, birincil IP `185.23.75.42`, nameserver adresleri `ns1.ehost.com.tr` ve `ns2.ehost.com.tr`, paket `eH 3 - Linux VDS`. Sonraki mesajda root parolası paylaşıldı: **[GİZLENDİ — PAROLA DOSYAYA KAYDEDİLMEDİ]**. Bu bilgilerle uygulama VDS'ye kuruldu.

8. **VDS kurulumu ve sitelerin bağlanması:** Ubuntu 24.04 üzerinde Node.js, Puppeteer/Chrome bağımlılıkları ve uygulama kuruldu. Uygulama `/opt/oran-analiz-pro` altında `oran-analiz` kullanıcısıyla, `oran-analiz.service` systemd servisi olarak çalışır. Caddy, `127.0.0.1:3000` üzerindeki uygulamaya HTTPS ters vekil sağlar. Kullanılan API adresi `https://oran-api.185-23-75-42.sslip.io` oldu. Netlify ve GitHub Pages bu API'ye bağlandı. Sunucunun otomatik başlangıcı ve HTTPS doğrulandı.

9. **Hataların tamamen bitip bitmediği sorusu:** Kullanıcı ilk yedi maçı yeniden listeleyerek “artık bu hataları vermeecek doğru mu?” diye sordu. Sonraki doğrulamalar erişimin düzeldiğini gösterdi; ancak hiçbir aşamada sağlayıcıların gelecekte 429/502 vermeyeceği garanti edilmedi. Eşleştirme sorunları ayrıca ele alındı.

10. **Diğer maçların analizi:** Kullanıcı “diğer maçlarıda analiz yap” dedi. Netlify üzerinde altı diğer çift, Maçkolik oranları, Sahadan geçmiş maçları ve tek kategori PNG indirmeleriyle incelendi. İlk denetimde Real Madrid–Sevilla 50, Bayer Leverkusen–Freiburg 51, Manchester City–Ipswich Town 49, Roma–Genoa 51 ve Strasbourg–PSG 50 oran döndürdü. Bazı Sahadan 502 yanıtları tek manuel tekrar sonrası düzeldi. Valencia başlangıç araması başarısız oldu; Valencia H2H yanlışlıkla kadın takımlarını, City H2H ise rezerv takımı seçiyordu. Bu denetimde ilk listedeki yazım varyasyonları yerine doğru kulüp adları kullanıldığı için `Sevillia` ve `Athletico Bilbao` sorunları o aşamada kapsanmamıştı.

11. **Eşleştirmeleri düzeltme talebi:** Kullanıcı “bu eşleştirme hataları düzelt” dedi. Sağlayıcıdaki `Man. City`, `Ath. Bilbao` ve `A. Bilbao` adları ortak eşleştiricide tanındı. Kadın, rezerv ve genç takım işaretleri ortak kimlik kontrolüne taşındı; `(K)`, `Res.`, yaş grupları ve ikinci/üçüncü takım işaretleri ana takımla karıştırılmadı. Web ve eklenti normalizasyonu birlikte güncellendi. Sahadan `sameTeam` aynı ortak kurala bağlandı.

12. **İnceleme ve regresyonların giderilmesi:** Kod incelemesi, `B. Dortmund`, `B. Leverkusen` ve `K. Beerschot` gibi adların başındaki harflerin takım eki sayılmaması gerektiğini gösterdi. Bu ayrım düzeltildi. `ManchesterCity`, `MC` ve `Bilbao` gibi mevcut güvenli eşleşmeler korundu. Tek başına `City` girdisi Manchester City'ye otomatik genişletilmedi. Bu aşamada toplam 65 test yerelde ve VDS'de geçti; düzeltme `b5f162b` ile yayımlandı.

13. **İlk eşleştirme düzeltmesinin canlı sonucu:** Altı çift yeniden denendi; her birinde oranlar, 10 Sahadan H2H satırı ve geçerli tek kategori PNG elde edildi. Valencia–Athletic Bilbao 51, Manchester City–Ipswich 49 oran döndürdü. Valencia satırlarının kadın takımı, City satırlarının rezerv takımı olmadığı kaynak satırlarından doğrulandı. GitHub Pages üzerinde de bu iki çift ve PNG akışları kontrol edildi. Asistan kullanıcıya düzeltmenin canlıya alındığını ve o kontrollerde 429 görülmediğini bildirdi.

14. **İki sitede güncellemelerin görünmesi:** Kullanıcı iki site adresini vererek “sitelere güncellemeler yansıdı mı?” diye sordu. Asistan iki sitenin güncellenen ortak VDS API'sini kullandığını, Manchester City–Ipswich ve Valencia–Athletic Bilbao sorgularının her iki sitede doğrulandığını bildirdi. Backend değişikliği için Netlify'nin değişmeyen arayüzünün yeniden derlenmesi gerekmedi; canlı arayüz yeni API davranışını kullandı.

15. **Render bağlantısı sorusu:** Kullanıcı “render bağlantısı kaldırıldı mı?” diye sordu. `netlify.toml`, GitHub Pages iş akışı ve frontend API ayarları kontrol edildi. Asistan sitelerin VDS'ye geçtiğini, Render servisinin o anda yalnızca geri dönüş için tutulduğunu ve siteler tarafından kullanılmadığını açıkladı.

16. **Render servisini silme talebi:** Kullanıcı “render'daki servis sil. bu sunucu 3 ay sonra süresi bitiyor. bende başka bir render servis açarım.” dedi. Render'daki `oran-analiz-pro` servisi, `srv-dadmhlgn74is73amq40g` kimliği ve doğru GitHub deposuyla doğrulandı. Önizlemenin ardından kullanıcının açık talebi doğrultusunda servis silindi. Render CLI `deleted: true` döndürdü; son servis listesi boştu. VDS `/api/health` yanıtı `{"status":"ok"}` kaldı. Asistan silmeyi ve mevcut sitelerin VDS'de çalıştığını bildirdi. Yeniden kurulum bilgileri `c1c6f3a` kaydında saklandı. Render hesabı veya diğer kaynaklar için ayrıca silme işlemi yapılmadı.

17. **Real Madrid–Sevillia hatasının yeniden bildirilmesi:** Kullanıcı Netlify'de “Real Madrid - Sevillia” analizinin “sahadan: HTTP 404” ve “mackolik: istenen geçmiş maç bulunamadı” hatalarını verdiğini bildirdi. Aynı girdi canlı API'de tekrarlandı; doğru `Sevilla` yazımı H2H sonucunu getirirken `Sevillia` eşleşmiyordu. Asistan önceki kontrolde doğru yazımı kullandığını ve bu varyasyonu kapsamamış olduğunu açıkça belirtti.

18. **Sevillia düzeltmesi ve doğrulaması:** Ortak web ve eklenti alias listelerine `Sevillia` → `Sevilla` eklendi. Kadın/rezerv/genç takımlar ve Sevilla Atletico ayrı tutuldu. Yeni testler düzeltmeden önce başarısız, sonra başarılı oldu. Toplam 70 test yerelde ve VDS'de geçti. `368a80a` VDS'ye dağıtıldı. Netlify'de tam `Real Madrid` / `Sevillia` girdisiyle 18.10.2026 tarihli maç için 50 doğrulanmış oran, 10 Sahadan geçmiş maç satırı ve 2400 × 3652 boyutunda geçerli PNG alındı. Asistan kullanıcıya sayfayı yenileyip yeniden deneyebileceğini bildirdi. Canlı doğrulama kaydı `1bf661a` ile GitHub'a gönderildi.

19. **Valencia–Athletico Bilbao hatasının yeniden bildirilmesi:** Kullanıcı “Valencia - Athletico Bilbao Kaynak: Sahadan” girdisinde “Bu takımlar için Sahadan karşılaştırma sayfası bulunamadı.” ve “mackolik: istenen geçmiş maç bulunamadı.” hatalarını bildirdi. Bu iki hata tam aynı yazımla canlı API'de tekrarlandı. `Athletic Bilbao` eşleşirken `Athletico Bilbao` eşleşmiyordu. Asistan önceki denemede doğru `Athletic Bilbao` yazımını kullandığını belirtti.

20. **Athletico Bilbao düzeltmesi ve doğrulaması:** Ortak web ve eklenti alias listelerine `Athletico Bilbao` → `Athletic Bilbao` eklendi. Atlético Madrid, kadın takımı, rezerv takım ve genç takım ayrımları korundu. Eşleştirme, Nesine maç bulma, Sahadan keşfi ve H2H HTML ayrıştırması testleri genişletildi. Düzeltmeden önce testlerin başarısız olduğu görüldü; ardından 72 test yerelde ve VDS'de geçti. `8e3af1f` VDS'ye dağıtıldı. Netlify'de tam `Valencia` / `Athletico Bilbao` girdisi hem Maçkolik hem Sahadan seçiliyken denendi: Maçkolik 51, Sahadan 93 doğrulanmış oran, her ikisinde 10 H2H satırı döndü. Tek kategori PNG'ler sırasıyla 2400 × 3652 ve 2400 × 4346 boyutunda geçerliydi. Asistan düzeltmenin canlı olduğunu bildirdi. Doğrulama kaydı `4082b79` ile GitHub'a gönderildi.

21. **Bu kayıt talebi:** Kullanıcı “buradaki tüm sohbeti AGENTS.md dosyasına bugünün tarihi ile güncel durum başlığı ile ekle” dedi. Bu bölüm 2026-10-19 tarihiyle, önceki yönergeler ve doğrulama kayıtları korunarak eklendi. Parola bilinçli olarak dışarıda bırakıldı.

### Son doğrulanan canlı durum

| Alan | Durum |
| --- | --- |
| Netlify | `https://oran-analiz-pro.netlify.app` — ortak VDS API'sini kullanıyor. |
| GitHub Pages | `https://ahmedyesovic.github.io/oran-analiz-pro/` — ortak VDS API'sini kullanıyor. |
| API | `https://oran-api.185-23-75-42.sslip.io` |
| Sunucu | Kullanıcının üç aylık eH 3 Linux VDS'si, `185.23.75.42`; kesin son kullanım tarihi paylaşılmadı. |
| Uygulama | `/opt/oran-analiz-pro`, `oran-analiz` kullanıcısı, `oran-analiz.service`, Caddy HTTPS. |
| Son yayımlanan uygulama düzeltmesi | `8e3af1f` — Athletico Bilbao yazımı. |
| Bu belge düzenlemesinden önceki son GitHub kaydı | `4082b79` — iki kaynakla canlı Athletico Bilbao doğrulaması. |
| Son otomatik doğrulama | 72 test, yerelde ve VDS'de başarılı. Bu belge düzenlemesi için testler yeniden çalıştırılmadı. |
| Render | Eski `oran-analiz-pro` servisi kullanıcının talebiyle silindi; çalışan Render yedeği yok. |
| Northflank | Uygulama çalıştıran yeni bir servis kurulmadı. |

### Doğrulanan maçlar

Bu tablo farklı denetimlerde alınan sonuçları birlikte listeler; bütün sorguların bu belge düzenlenirken yeniden çalıştırıldığı anlamına gelmez. H2H satır sayısı sabitlenmemiştir; bu örneklerde kaynağın ilk HTML tablosundan 10 satır gelmiştir.

| Girdi / takım çifti | Doğrulanan oranlar | H2H / PNG |
| --- | --- | --- |
| Real Betis–Barcelona | Maçkolik: 51 | İki sitede 10 H2H satırı ve geçerli PNG. |
| Real Madrid–Sevilla | Maçkolik: 50 | 10 H2H satırı ve geçerli PNG. |
| Real Madrid–Sevillia | Maçkolik: 50 | Tam bildirilen yazımla Netlify'de 10 H2H satırı ve geçerli PNG. |
| Bayer Leverkusen–Freiburg | Maçkolik: 51 | 10 H2H satırı ve geçerli PNG. |
| Manchester City–Ipswich Town | Maçkolik: 49 | Ana takımlara ait 10 H2H satırı; iki sitede geçerli PNG. |
| Valencia–Athletic Bilbao | Maçkolik: 51 | Kadın takımlarından ayrılmış 10 H2H satırı; iki sitede geçerli PNG. |
| Valencia–Athletico Bilbao | Maçkolik: 51; Sahadan: 93 | Tam bildirilen yazımla Netlify'de iki kaynakta 10 H2H satırı ve geçerli PNG. |
| Roma–Genoa | Maçkolik: 51 | 10 H2H satırı ve geçerli PNG. |
| Strasbourg–PSG | Maçkolik: 50 | 10 H2H satırı ve geçerli PNG. |

### Devam edecek kişi için önemli bilgiler

- Paylaşılan parolayı, erişim anahtarlarını veya token'ları bu dosyaya, kaynak koda ya da Git geçmişine ekleme. Bu kayıt bir kimlik bilgisi yedeği değildir.
- Kullanıcının yazdığı tam girdiyi yeniden üretmeden “düzeldi” deme. İlk canlı kontroller doğru kulüp adlarını kullandığı için `Sevillia` ve `Athletico Bilbao` yazımları ancak sonraki bildirimlerde kapsandı.
- Desteklenen açık varyasyonlar arasında `Sevillia` → `Sevilla`, `Athletico Bilbao` → `Athletic Bilbao`, `Man. City` → `Manchester City`, `Ath. Bilbao` / `A. Bilbao` / `Bilbao` → `Athletic Bilbao` bulunur. Alias değişikliklerini hem `utils/normalize.js` hem `extension/utils/normalize.js` içinde aynı davranışla sürdür.
- Tek başına `City` belirsizdir ve otomatik Manchester City alias'ı değildir. Geniş, doğrulanmamış yazım benzerliği kuralları ekleme; kadın/rezerv/genç takımları ana takıma dönüştürme.
- `/api/head-to-head` her zaman Sahadan kullanır. Oran kaynağı seçimi bu isteğin kaynağını değiştirmez. Sahadan karşılaştırma tablosunun ilk HTML satırlarını ve kaynak kimliğini koru.
- HTTP 429, sağlayıcı 502/404 ve kimlik/eşleştirme hataları farklı nedenler olabilir. Geçerli geçmiş sonuçta oran arşivi olmamasıyla sağlayıcı hatasını ayır. Yeni sunucu gelecekte 429 yaşanmayacağı anlamına gelmez.
- Bağımsız eklenti testlerinin mevcut engelleri: `test_suite.js` eksik `evaluateMatchMatch` export'unu, `test_ai_export.js` eksik `extension/utils/marketDefinitions.js` dosyasını bekliyor. Web regresyonları gerçek eklenti eşleştiricisini ayrıca test ediyor; bu iki eski suite'in geçtiğini söyleme.
- Son değişiklikler backend/eşleştirme kapsamındaydı. Güncel turlarda mobil/tema etkileşimleri, tüm kategori PNG dışa aktarımı ve lint yeniden kontrol edilmedi. Tek kategori PNG ve masaüstü ekran denetimi bu kapsamların yerine geçmez.
- Kullanıcı VDS'nin yaklaşık üç ay sonra biteceğini ve sonra başka bir Render servisi açacağını söyledi. Kesin bitiş tarihi bilinmediğinden otomatik son kullanım tarihi uydurma. Kullanıcı yeni Render servisini açtığında yeni HTTPS adresini `netlify.toml` ve GitHub deposundaki `API_BASE_URL` değişkenine yazıp iki frontend'i yeniden yayımla. Silinen Render URL'sinin yeniden aynı olacağını varsayma.
- Render yeniden kurulum bilgileri: GitHub deposu `ahmedyesovic/oran-analiz-pro`, dal `main`, Node runtime, boş root directory, build `npm install && npm run build`, start `npm start`, health check `/api/health`. Eski servis Frankfurt/free planındaydı; yeni servisin o günkü plan ve sağlayıcı erişimi ayrıca doğrulanmalıdır.

## Güvenilir arama yayını — 2026-10-19 (son doğrulama)

Önceki sohbet kaydı o aşamanın tarihsel kaydıdır. Bu bölüm uygulama sürümü `a557786` için daha sonra yapılan doğrulamayı kaydeder; önceki kayıtlar silinmemiştir. Ayrıntılı kanıtlar ve kapsam sınırları: `docs/verification-2026-10-19-reliability.md`.

- Kullanıcı tekrar eden takım adı/kaynak hatalarına kalıcı çözüm istedi; yazarken takım önerisi seçeneğini seçti ve planın uygulanmasını onayladı. Takım alanları artık en az iki karakterden sonra öneri gösterir; listeden seçim sabit, kaynak kapsamı doğrulanan takım kimliklerini gönderir. Serbest metin arama korunur. Yazım benzerliği yalnızca öneri üretir; otomatik kimlik kanıtı değildir.
- `web/src/reliabilityStore.js` SQLite kayıtlarını, `teamDirectory.js` doğrulanmış takım rehberini, `verifiedCache.js` tamamlanmış maç/arşiv doğrulamasını yönetir. Kaynaklar aynı görünen UUID üzerinden otomatik birleştirilmez. Ayrı kaynak kayıtları yalnızca doğrulanmış Nesine maç kodu, tarih, skor, iki takım kimliği ve kadro türü kanıtlarıyla ortak öneride gösterilir. Kaynak kayıtları korunur; eksik takım kayıtları geçerli arşiv kanıtından tamamlanabilir.
- Kalıcı veri yolu `/var/lib/oran-analiz/data.sqlite`; systemd servisinde `NODE_ENV=production` ve `ORAN_DATA_DIR=/var/lib/oran-analiz` açıkça ayarlı. SQLite dosyasını canlı WAL yazımı sürerken tek başına kopyalama; `docs/reliability-operations.md` içindeki çevrimiçi yedekleme/geri yükleme yöntemini kullan. Gelecekte Render veya başka sunucuya taşınırken yazılabilir `ORAN_DATA_DIR` ve doğrulanmış SQLite yedeği ayrıca taşınmalıdır.
- Doğrulanmış tamamlanmış oranlar kesin kaynak/maç kimliği/tarih anahtarıyla kalır. Oranı bulunmayan arşiv 24 saat, takım çifti keşfi bir saat geçerlidir. H2H 15 dakika güncel sayılır; kaynak hatası veya toplam süre aşımında en fazla 24 saatlik doğrulanmış tablo açık kayıt tarihiyle gösterilebilir. Eski güncel oranlar gösterilmez. Eksik/malformed kaynak yanıtı, yanlış kimlik/kadro, bağlantı hatası ve gerçekten bulunamayan maç ayrı kalır.
- Kaynak başına eşzamanlı istek sınırı iki, bekleyen kuyruk sınırlı, toplam arama bütçesi 120 saniyedir. Geçici bağlantı/502/503/504 hatasında en fazla bir otomatik tekrar vardır. 429 bekleme süresi SQLite üzerinde yeniden başlatma sonrasında korunur; 404 veya doğrulama hatası tekrar edilmez.
- 218 regresyon testi yerelde, birleşen main üzerinde ve VDS test ortamında Node.js v24.22.0 ile geçti. Lint dört mevcut uyarıyla başarılı; üretim derlemeleri başarılı. Bağımsız son inceleme önceki üç bulgunun düzeldiğini onayladı. Eski iki bağımsız eklenti testinin daha önce kaydedilen eksik import engelleri için yeni başarı iddiası yoktur.
- VDS test ortamında sekiz bildirilen tam girdi ve iki doğru yazım tekrarı her iki oran kaynağıyla kontrol edildi. Den Haag/PSV: Maçkolik 47, Sahadan 78 doğrulanmış oran ve 10 H2H satırı. Roma/Genoa Sahadan ilk kontrolde 502 verdi; daha sonraki normal tarihli sorguda 93 oranla düzeldi. Gerçek seçili takım kimlikleri, servis yeniden başlatması ve ayrı SQLite yedeği üzerinde kontrollü kaynak kesintisi de doğrulandı; kesin kayıtlı arşiv sağlayıcı çağrısı olmadan açıldı, geçerli eski H2H tablosu korundu, kayıtsız sorgu kaynak hatası verdi.
- Üretim sürümü `a557786`, gerçek checkout yolu `/opt/oran-analiz-pro`; önceki uygulama `/opt/oran-analiz-pro-before-a557786`, çevrimiçi yedek `/var/backups/oran-analiz/staging-verified-a557786.sqlite`. İlk sembolik bağlantı geçişi mevcut ana modül kontrolü nedeniyle servis başlatmadı ve otomatik geri döndü; başarılı yayın gerçek dizin taşımasıyla yapıldı. Bu servis için aynı ana modül davranışı korunuyorsa checkout yolunu sembolik bağlantıya dönüştürme.
- Netlify ve GitHub Pages `a557786` arayüzünü yayımladı; ikisi de `index-CJtsT3Pg.js`/`index-CPkqiRO2.css` ve ortak VDS API'sini kullanıyor. GitHub Pages iş akışı `39277565286` başarılı. Canlı Chrome'da iki sitede de tam Den Haag/PSV girdisi, tekil öneriler, klavyeyle seçim, iki oran kaynağı, doğru 2026-10-17 arşivi ve 10 H2H satırı doğrulandı. Netlify ağ panelinde iki isteğin aynı seçili takım kimliklerini taşıdığı ve geçmiş satır seçiminin yalnızca sabit maç kimliği/tarihli oran isteği eklediği görüldü. İki sitede geçmiş seçim H2H kaynağını ve kaydırmayı korudu. Ayrı Maçkolik tek kategori PNG'leri 2400 × 3680, 500.541 bayt olarak doğrulandı; Sahadan PNG ve tüm kategori dışa aktarımı bu turda tekrarlanmadı. Yerel 320/390/768/1280 px ve üç tema kontrolleri yapıldı; tam tema/boyut matrisi ve fiziksel dokunma/masaüstü hover kapsamı eksik. Ayrıntılar doğrulama belgesindedir.
- `oran-analiz-audit.timer` her gün 03:30 Europe/Istanbul için etkin; ilk otomatik denetim başarılı. Son özel rapor `/var/lib/oran-analiz/reliability-audit.json`. Bu denetim dışarı mesaj göndermez; API erişilebilirliğini ve kayıt kullanımını raporlar, taze doğrudan kaynak kanıtı iddiasında bulunmaz. VDS test servisi durdurulmuştur.
- Bu sonuçlar kayıtlı maçların sağlamlığını ve yapılan sorguları doğrular; ilk kez istenen, kaydı bulunmayan bir maç yine kaynağın erişilebilir ve doğrulanabilir olmasını gerektirir.

## Güncel Durum — 2026-10-19 (sohbetin devamı ve son durum)

Bu bölüm, yukarıdaki kapsamlı sohbet kaydını ve güvenilir arama yayını notlarını koruyarak konuşmanın devamını ekler. Birlikte okunduklarında bu sohbetteki kullanıcı taleplerini, alınan kararları, yapılan işlemleri, verilen yanıtların içeriğini ve son doğrulanan durumu kapsarlar. Bu kayıt birebir mesaj dışa aktarımı değildir; önceki asistan mesajlarının tamamının kelimesi kelimesine metni mevcut bağlamda bulunmadığından kapsamlı bir konuşma ve çalışma kaydıdır. Parola, token, özel anahtar veya başka kimlik doğrulama bilgisi içermez. Önceki bölümlerdeki eski sürüm/test sayısı tabloları tarihsel aşamaları gösterir; en son durum bu bölüm ve `docs/verification-2026-10-19-reliability.md` ile değerlendirilmelidir.

### Sohbetin devamı: talepler, işlemler ve yanıtlar

22. **Den Haag–PSV hatası:** Kullanıcı Netlify ve GitHub Pages adreslerini vererek tam `Den Haag` / `PSV` girdisinde **Oranları Bul** işleminin “mackolik: istenen geçmiş maç bulunamadı.” hatasını bildirdi. Doğru girdiyi değiştirmeden yeniden üretmek esas alındı. Günlük akıştaki `Den Haag` / `PSV` ile arşivdeki `ADO Den Haag` / `PSV Eindhoven` adlarının eşleştirilmesi araştırıldı. Ortak web ve eklenti eşleştiricilerine açık PSV varyasyonu eklendi; Jong PSV, FC Eindhoven ve kadro ayrımları korundu. Yeni testler önce başarısız, düzeltmeden sonra başarılı oldu. Bu aşamada 74 test yerelde ve VDS'de geçti; düzeltme `e78479e` olarak kaydedilip yayımlandı. İki sitede doğru arşiv ve 10 H2H satırı görüldü. İlk Netlify H2H denemesinde bağlantı hatası oluştu; sonraki normal sorguda düzeldi. Bu ilk düzeltme için PNG/tema/mobil kontrolleri yapılmış gibi gösterilmedi.

23. **Sunucuda düzenleme yetkisi:** Kullanıcı “Sunucu üzerinden düzenle” diyerek `azarbayram0`, `185.23.75.42`, `ns1.ehost.com.tr` ve `ns2.ehost.com.tr` bilgilerini, ayrıca sunucu erişim bilgisini paylaştı. İstenen VDS üzerinde çalışma ve yayınlama kapsamı korundu. Kimlik doğrulama bilgisinin değeri bu dosyaya veya kaynaklara eklenmedi; parola bu sohbet kaydında da saklanmaz.

24. **Tek tek hata bildirmek yerine çalışan çözüm talebi:** Kullanıcı “bu tür sorunlarda hep gelip şu sorun var bu sorun var demek can sıkıcı bunun bir çözüm yolu yok mu? Ama deneysel değil çalışan çözüm yolu istiyorum” dedi. Sorunun yalnızca yeni alias eklemekten ibaret olmadığı ele alındı: takım kimliği, kaynak erişimi, geçmiş arşiv, kaynak hatası ile bulunamayan maçı ayırma ve düzenli denetim birlikte planlandı. Kaynakların gelecekte hiç hata vermeyeceği sözü verilmedi.

25. **Arama tercihi ve plan onayı:** Kullanıcı yazarken öneri gösterme seçeneğini tercih etti; ardından “Implement the plan.” dedi. Onaylanan plan `docs/superpowers/plans/2026-10-19-reliable-team-search.md` altında kaydedildi. Kapsam; kalıcı takım rehberi/SQLite, sabit kimlikli öneriler, sağlayıcı istek koordinasyonu, doğrulanmış geçmiş arşiv, açık önbellek tarihi, günlük yerel denetim ve VDS ile iki frontend'e doğrulanmış yayındı. Nesine dışı oran eklememek, H2H ilk HTML tablosunu korumak, kaynak seçimi/tema/Temizle ve bağımsız istek davranışını bozmamak temel koşullardı.

26. **İzolasyon ve uygulama:** Çalışma `e78479e` tabanından `codex/reliable-team-search` dalında `/private/tmp/oran-reliability-20261019` izole çalışma ağacında yapıldı. Mevcut yerel AGENTS.md eklemeleri korunarak bağımsız dosya sahipliğiyle paralel geliştirme ve inceleme yürütüldü. Sunucudaki uygulamaya dokunmadan `/opt/oran-analiz-reliability-stage`, loopback 3001 ve ayrı `/var/lib/oran-analiz-stage/data.sqlite` ile test ortamı kuruldu. `better-sqlite3` 13.0.3 kilitlendi; Node alt sınırı 22 oldu, gerçek doğrulamalar Node.js v24.22.0 ile yapıldı. VDS'deki yerel SQLite modülü kurulumu için gereken standart derleme araçları kuruldu.

27. **Kalıcı kimlik ve arşiv davranışı:** SQLite, sürümlenmiş kayıtları ve kaynak bekleme sürelerini saklar. Takım önerileri en az iki karakter, 300 ms gecikme ve en fazla sekiz seçenekle çalışır; klavye, pointer ve iptal/geç yanıt koruması vardır. Öneri seçimi `homeTeamId` / `awayTeamId` gönderir; alan düzenlenince kimlik temizlenir. Yanlış yazım benzerliği yalnızca öneri içindir. Kaynak kimlikleri kendi ad alanları içinde doğrulanır; aynı görünen UUID tek başına birleştirme kanıtı değildir. Geçerli Nesine arşivleri eksik rehber kayıtlarını tamamlayabilir; iki kaynak aynı doğrulanmış maç kodu, tarih, skor, iki takım kimliği ve kadro kanıtıyla tek öneride birleştirilebilir. Ham kaynak kimlikleri ve eski doğrulanmış adlar korunur.

28. **Kaynak dayanıklılığı ve doğru hata ayrımı:** Kaynak başına iki eşzamanlı istek, sınırlı kuyruk, aynı işin yinelenmesini önleme ve toplam 120 saniyelik bütçe uygulandı. Geçici bağlantı/502/503/504 için bir otomatik tekrar bulunur; 429/404, bozuk veri, kimlik doğrulama, TLS veya programlama hatası körlemesine tekrar edilmez. `Retry-After` ve 429 bekleme süresi yeniden başlatma sonrasında korunur. Güncel/recent/günlük akış/web araması sırası sürer; bir aday ya da gün başarısızsa diğer uygun adaylar denenebilir, bütün kaynak başarısızlığı “maç bulunamadı” diye gizlenmez. Tarayıcı yedeğinin HTTP, kimlik, skor, süre ve kaynak temizleme kontrolleri de tamamlandı.

29. **Arşiv ve H2H sınırları:** Tamamlanmış doğrulanmış maçlar kaynak/maç kimliği/tarih anahtarıyla kalıcıdır. Bulunmayan oran arşivi 24 saat sonra tekrar denenebilir; takım çifti keşfi bir saat geçerlidir. Eski güncel oranlar kesinti bahanesiyle gösterilmez. Sahadan H2H 15 dakika güncel sayılır; hata veya toplam süre aşımında, en fazla 24 saatlik doğrulanmış ilk tablo kayıt tarihi ve eski kayıt uyarısıyla kullanılabilir. Önceden seçilen tarihi satır doğrudan sabit maç kimliği/tarihiyle açılır; H2H kaynağı, satırları ve kaydırması korunur.

30. **İncelemeler ve gerçek veriden bulunan uç durumlar:** Son incelemede, adı değişen takımın gerçek rehberle kaydedilmesinde eski ad kanıtının kaybolması, günlük akış takım kimliklerinin son arşiv doğrulamasına taşınmaması ve toplam süre aşımı yarışının H2H eski kayıt dönüşünü atlaması yeniden üretildi. Her biri önce başarısız olan regresyonlarla düzeltildi. Gerçek Den Haag verisi ayrıca, karşı takımın bir kaynak rehber kaydı eksik olduğunda iki önerinin kalabildiğini gösterdi; doğrulanmış arşiv kanıtından eksik kayıt tamamlama ve iki tarafı kaydetme eklendi. Node 24 üzerinde takılabilen testin sahte zamanlayıcı/başlangıç beklemesi, sınırlı gerçek süre ve koruma ile uyumlu hale getirildi. Son bağımsız dar inceleme üç eski bulgunun çözüldüğünü ve yeni bir kimlik atlatma engeli bulunmadığını onayladı; 33 odaklı test geçti. Tam regresyon toplamı 218 oldu.

31. **Gerçek kaynak denetimi:** VDS test ortamında sekiz bildirilen tam takım çifti ile `Real Madrid / Sevilla` ve `Valencia / Athletic Bilbao` doğru yazım tekrarları, iki oran kaynağı ve bağımsız Sahadan H2H ile sırayla kontrol edildi. İlk Roma/Genoa Sahadan sorgusu bir otomatik tekrara rağmen 502 verdi; daha sonraki normal tarihli sorgu 93 doğrulanmış oranla düzeldi. Bu ilk hata başarıya çevrilerek raporlanmadı. Son seçili takım kimlikleri Den Haag/PSV için iki kaynakta da çalıştı. Servis yeniden başlatması ve SQLite çevrimiçi yedeğindeki kontrollü kaynak kesintisi denemesinde, kesin kayıtlı arşiv sağlayıcı çağrısı olmadan döndü; geçerli eski H2H korundu, kayıtsız sorgu kaynak hatası verdi. Gerçek sunucu ağı kesilmedi.

32. **Yayın ve geri dönüş:** Uygulama `a557786` ile kaydedildi; main'e hızlı ileri birleştirildi. 218 test izole yerelde, birleşen yerel main'de ve VDS test ortamında geçti. Lint dört önceden bulunan uyarıyla başarılı oldu; yerel ve VDS üretim derlemeleri geçti. İlk sembolik bağlantı yayını, mevcut ana modül/argv kontrolü nedeniyle sunucuyu başlatmadı; koruma eski uygulamayı geri getirdi. Gerçek checkout yolu korunarak yapılan dizin taşımasıyla yayın tamamlandı. Üretim servisinin yolu `/opt/oran-analiz-pro`, önceki uygulama `/opt/oran-analiz-pro-before-a557786`, doğrulanmış SQLite çevrimiçi yedeği `/var/backups/oran-analiz/staging-verified-a557786.sqlite` oldu. `ORAN_DATA_DIR=/var/lib/oran-analiz` açıkça ayarlandı. Sağlık ve kayıtlı 47 oranlı Den Haag arşivi doğrulandı. Test servisi durduruldu.

33. **İki frontend ve tarayıcı sonucu:** Netlify `a557786` sürümünü `6ad636032aeee432790b027a` dağıtımıyla yayımladı; GitHub Pages iş akışı `39277565286` başarıyla tamamlandı. İki sitede de `index-CJtsT3Pg.js` ve `index-CPkqiRO2.css` görüldü. Canlı Chrome'da tam Den Haag/PSV girdisi, tekil ana takım önerileri, klavyeyle seçim, doğru 17.10.2026 arşivi, Maçkolik 47 ve Sahadan 78 oran ile 10 H2H satırı doğrulandı. Netlify ağ panelinde oran/H2H isteklerinin aynı seçili takım kimliklerini taşıdığı görüldü. Tarihi satır yalnızca sabit maç kimliği/tarih içeren oran isteği ekledi; H2H tablosu/kaynağı/kaydırması iki sitede de korundu. Her iki siteden ayrı Maçkolik tek kategori PNG'si üretildi; ikisi de 2400 × 3680 ve 500.541 bayttı, dosya başlığı ve görünümü incelendi. Sahadan PNG bu turda yeniden üretilmedi.

34. **Görsel kontrollerin kapsamı:** Yerel Chrome'da 320/default, 390/black, 768/white ve 1280/default genişlik/tema örnekleri, ayrıca dolu beyaz sonuç kontrol edildi. Arama/Temizle yan yana kaldı; klavye/pointer seçimleri, düzenleme, Escape, temizle sonrası odak, arşiv tarihi ve H2H koruması incelendi. 320 px kontrolünde önceden bulunan tüm kategoriler düğmesinin 220 px asgari genişliğinin iç paneli birkaç piksel aşabildiği, fakat görünüm alanında yatay taşma görülmediği not edildi; bu görsel nokta değiştirilmedi. Bu denetim tüm genişlik × tema matrisi, fiziksel dokunmatik, masaüstü hover, sekiz önerilik listenin görsel kaydırması ve tüm kategoriler PNG akışının tamamen sınandığı anlamına gelmez. Önceden bilinen iki bağımsız eklenti suite'inin eksik import engelleri sürer; 218 web testi gerçek eklenti eşleştiricisini ayrıca kapsar.

35. **Düzenli denetim ve verilen sonuç yanıtı:** `oran-analiz-audit.timer` her gün 03:30 Europe/Istanbul için etkinleştirildi. İlk denetim Real Madrid/Sevillia ve Leverkusen/Freiburg için `ok:true`, çıkış 0 ile tamamlandı. Özel ve sınırlı son rapor `/var/lib/oran-analiz/reliability-audit.json`; veri, yedek ve rapor izinleri 0600, sahibi uygulama kullanıcısı olarak doğrulandı. Denetim dışarı bildirim göndermez; API başarısı/önbellek durumunu açıkça ayırır ve taze doğrudan sağlayıcı kanıtı iddiasında bulunmaz. Asistan kullanıcıya planın uygulandığını, iki sitenin güncel olduğunu, 218 test ve Den Haag sonuçlarını, iki sitedeki PNG başarısını bildirdi; kaydı bulunmayan maçların kaynak erişimine bağlı kaldığını belirtti.

36. **Yerel/sunucu dosyalarının eşitliği sorusu:** Kullanıcı “sunucuya ve localde de tüm dosyalar güncellendi mi?” diye sordu. Gerçek Git kontrollerinde yerel `de269ce`, sunucu `a557786` idi; farkın yalnızca AGENTS.md ve `docs/verification-2026-10-19-reliability.md` olduğu görüldü. Bu fark gizlenmedi. Sunucuda `git pull --ff-only origin main` ile belgeler de alındı; iki checkout `de269ce` olarak ve temiz Git durumuyla doğrulandı. Yerel React arayüzü yeniden derlendi: yerel API'ye yönelen `index-BB6dtk4n.js` ve ortak `index-CPkqiRO2.css` çıktı. Yerel API adresi ile yayın API adresi farklı olduğundan üretilmiş JS dosya adının farklı olması beklenir; kaynak dosyaları aynı sürümdür. Sunucu servisi `active`, dış HTTPS `/api/health` yanıtı `{"status":"ok"}` kaldı. Asistan bu eşitliği ve başarılı yerel derlemeyi kullanıcıya bildirdi.

37. **Bu son kayıt talebi:** Kullanıcı “Buradaki tum sohbeti AGENTS.md dosyasina güncel durum başlığı ile ekle” dedi. Önceki tüm kayıtlar korunarak bu devam bölümü 2026-10-19 tarihiyle eklendi. Kimlik doğrulama bilgileri dışarıda tutuldu. Bu işlem belge güncellemesidir; uygulama davranışı değiştirilmedi ve 218 testin bu belge işlemi için yeniden çalıştırıldığı iddia edilmez.

### Son kaynak sorgularında doğrulanan sayılar

Aşağıdaki sonuçlar yukarıda anlatılan denetimlere aittir; bu belge yazılırken yeniden kaynak sorgusu yapılmış gibi değerlendirilmemelidir. Her sorgu yalnızca doğrulanmış Nesine oranlarını kabul eder. H2H sayısı sabit bir ürün kuralı değildir; bu örneklerde ilk HTML tablosu 10 satır döndürmüştür.

| Tam girdi | Maçkolik | Sahadan | Sahadan H2H |
| --- | ---: | ---: | ---: |
| Real Madrid / Sevillia | 50 | 101 | 10 |
| Bayer Leverkusen / Freiburg | 51 | 91 | 10 |
| Manchester City / Ipswich Town | 49 | 99 | 10 |
| Real Betis / Barcelona | 51 | 101 | 10 |
| Valencia / Athletico Bilbao | 51 | 93 | 10 |
| Roma / Genoa | 51 | 93 — sonraki sorguda toparlandı | 10 |
| Strasbourg / PSG | 50 | 99 | 10 |
| Den Haag / PSV | 47 | 78 | 10 |

### Devam edecek kişi için en son durum

- Çalışan işlevsel değişiklik `a557786`; bu son belge eklemesinden önce yerel ve sunucu checkout'larını eşitleyen kayıt `de269ce` idi. Daha sonraki belge commit'lerini yeni uygulama/test sonucu gibi sunma.
- Canlı siteler Netlify ve GitHub Pages; ortak API `https://oran-api.185-23-75-42.sslip.io`. Eski Render servisi silinmiş durumda; yeni bir Render servisi kurulmadı. Northflank üzerinde çalışan alternatif yok.
- VDS uygulaması gerçek `/opt/oran-analiz-pro` dizininde `oran-analiz.service` ile çalışır. Üretim veri dizinini veya SQLite dosyasını Git'e ekleme; taşımada kod, doğrulanmış çevrimiçi veri yedeği ve `ORAN_DATA_DIR` ayarı birlikte ele alınmalıdır.
- Bir sonraki hata incelemesinde bildirilen tam girdiyi ve seçili kaynağı koru; seçili takım/maç kimliklerini, tarihi, kadro ayrımını ve kayıt/kaynak hata türünü birlikte doğrula. Yeni bir geniş otomatik benzerlik kuralı ekleyerek belirsiz takımları birleştirme.
- Son yapılan değişiklik yalnızca sohbet kaydıdır; kaynaklar ve bütün tarayıcı/eklenti kapsamı bu dosya düzenlemesi sırasında tekrar sınanmadı. Gerçek doğrulama kapsamı yukarıda ve ayrı doğrulama belgesinde kayıtlıdır.

## Güncel Durum — 2026-10-23: Otomatik bant sınıflandırması ve yayın

- Kullanıcı önce geliştirmelerin lokalde yapılmasını ve yayına kendisinin karar vermesini istedi. Bant özelliğini lokalde test edip doğru bulduktan sonra bu sürümün GitHub, VDS ve iki siteye yayınlanmasını açıkça istedi. Gelecekteki yeni geliştirmeler varsayılan olarak lokalde test edilir; yeni bir yayın için kullanıcının talebi esas alınır. Paylaşılan kimlik doğrulama bilgileri kayda alınmadı.
- İşlevsel commit `3b235aa`: Oranları Bul sonucunda normal süre Maç Sonucu 1/X/2 verisinden deterministik B0–B7 Evb/Depb sınıflandırması gösterilir. GPT çağrısı yoktur. MSX favoriyi belirlemez; eşitlik, kapalı oran, şüpheli/eksik veri ve çelişen set kuralları uygulanır. Yalnız doğrulanmış Nesine oranları kullanılır. Sınıflandırma ekrandadır; PNG ve pano metnine eklenmez.
- `web/src/matchBand.js` sınıflandırıcıdır. Ayrıştırıcılar orijinal ondalık hassasiyetini ve açık/kapalı/eksik/geçersiz durumlarını `matchResultOdds` içinde korur; ortak API yanıtı `bandClassification` üretir. Yuvarlanmış eski market değerlerinden kesin bant veya kapalı durumu türetme.
- Sunucudaki 159 eski arşiv topluca taranmadı. Kullanıcının seçimiyle eski oranlı kayıt arandıkça sabit maç ID/tarih/kaynakla tamamlanır. Başarısız yenileme eski arşivi silmez; bant üretmez ve açıklama gösterir. En az15 dakika veya daha uzun Retry-After beklenir, tekrar sınırı kalıcıdır. Aynı arşiv yenilemeleri birleştirilir ve toplam istekte önbellek yanıtına zaman bırakılır.
- 239 otomatik test yerelde ve VDS test ortamında geçti; lint dört mevcut uyarıyla, iki derleme başarılı. Yerel tarayıcı testi 12 genişlik/tema birleşiminde geçti. Bağımsız incelemedeki yinelenen etiket, gizli HTML oranı, disk-yazma hatası ve dış süre sınırı durumları başarısız testle yeniden üretilip düzeltildi.
- Backend önce ayrı `/opt/oran-analiz-band-stage` ve `/var/lib/oran-analiz-band-stage` ortamında doğrulandı, sonra gerçek dizin taşımasıyla `/opt/oran-analiz-pro` altında yayına alındı. Üretim veri yolu `/var/lib/oran-analiz` korundu; servis ve denetim zamanlayıcısı aktif. Önceki kod `/opt/oran-analiz-pro-before-bands-3b235aa-20261023T195537Z`; yayın öncesi çevrimiçi ve quick_check doğrulanmış SQLite yedeği `/var/backups/oran-analiz/release-match-bands-2026-10-23T19-55-38.044Z.sqlite`.
- Netlify deploy `6adbbbecba492e132419256d` ve GitHub Pages iş akışı `40015338449` başarılı. İki site `index-D5gkqYi7.js` ve `index-CPkqiRO2.css` dosyalarını ve mevcut VDS HTTPS API'sini kullanır. Yerel derleme localhost/aynı-origin ayarını korur.
- Canlı Chrome'da iki sitede tam Den Haag/PSV girdisi iki kaynakla Depb0 ve 10 H2H satırı gösterdi; tarihsel seçim ve Temizle kontrol edildi. Pages'te yeni güncel CSD Imperial/CD Marquense araması Evb2 ve 10 H2H satırı gösterdi. Pages'te 320/390/768/1280 px ve üç temadan örnekler incelendi; canlı tam tema/genişlik matrisi ve fiziksel dokunmatik kontrolü yapılmadı. Netlify Maçkolik PNG 2400×3680/500541 bayt; Pages Sahadan PNG 2400×4378/613527 bayt doğrulandı. Tüm kategori PNG akışı bu turda tekrarlanmadı.
- Ayrıntılı kanıtlar, yedekler ve kapsam sınırları: `docs/verification-2026-10-23-band-rollout.md`. Bu sonuçlar belirtilen sorguların kontrol anındaki durumudur; sağlayıcıların gelecekte kesintisiz erişileceği anlamına gelmez. Bu kaydı güncellemek için kimlik bilgisi, veri tabanı veya token ekleme.
