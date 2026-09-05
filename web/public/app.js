import { exportAllCategoriesAsPNG } from './js/aiExportRenderer.js';
import { renderHistoricalMatches } from './js/historicalUI.js';

document.addEventListener('DOMContentLoaded', () => {
    const searchBtn = document.getElementById('search-btn');
    const homeInput = document.getElementById('home-team');
    const awayInput = document.getElementById('away-team');
    const errorMsg = document.getElementById('error-message');
    const resultsSection = document.getElementById('results-section');
    const btnText = searchBtn.querySelector('.btn-text');
    const btnLoader = searchBtn.querySelector('.btn-loader');
    const copyBtn = document.getElementById('copy-btn');
    const aiExportBtn = document.getElementById('ai-export-btn');
    const aiExportProgress = document.getElementById('ai-export-progress');
    const aiProgressTitle = document.getElementById('ai-progress-title');
    const aiProgressCount = document.getElementById('ai-progress-count');
    const aiProgressFill = document.getElementById('ai-progress-fill');
    let lastFetchedData = null;

    searchBtn.addEventListener('click', performSearch);

    // Enter'a basınca arama yap
    [homeInput, awayInput].forEach(input => {
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') performSearch();
        });
    });



    copyBtn.addEventListener('click', copyToClipboard);

    aiExportBtn.addEventListener('click', async () => {
        if (!lastFetchedData || !lastFetchedData.markets) return;

        aiExportBtn.disabled = true;
        aiExportProgress.classList.remove('hidden');
        aiProgressTitle.textContent = 'Görseller hazırlanıyor...';
        aiProgressCount.textContent = '0/8';
        aiProgressFill.style.width = '0%';

        try {
            const files = await exportAllCategoriesAsPNG({
                match: lastFetchedData.match || {
                    home: homeInput.value.trim(),
                    away: awayInput.value.trim(),
                    name: lastFetchedData.matchName,
                    code: lastFetchedData.matchCode,
                    date: lastFetchedData.matchDate,
                    time: lastFetchedData.matchTime
                },
                categories: lastFetchedData.markets,
                onProgress: ({ current, total, categoryName }) => {
                    aiProgressTitle.textContent = `${categoryName} hazırlanıyor...`;
                    aiProgressCount.textContent = `${current}/${total}`;
                    const pct = Math.round((current / total) * 100);
                    aiProgressFill.style.width = `${pct}%`;
                }
            });

            aiProgressTitle.textContent = `Tamamlandı! (${files.length} PNG indirildi)`;
            setTimeout(() => {
                aiExportProgress.classList.add('hidden');
            }, 3500);
        } catch (err) {
            console.error('AI Export Hatası:', err);
            aiProgressTitle.textContent = 'Hata oluştu!';
            alert('AI görselleri üretilirken bir hata oluştu: ' + err.message);
        } finally {
            aiExportBtn.disabled = false;
        }
    });

    function parseMatchInput(input) {
        if (!input) return null;
        // Ayraçlar: -, –, —, /, vs, v (kelime sınırları ile)
        const regex = /\s*(?:-|–|—|\/|\bvs\b|\bv\b)\s+/i; // 'v' veya 'vs' sonrası boşluk zorunlu olsun ki 'Aston Villa' vs bölünmesin, ama '-' boşluksuz da olabilir
        // Wait, '-' kelime sınırına ihtiyaç duymaz ama 'v' duyar.
        // Daha güvenli regex:
        const safeRegex = /\s*(?:-|–|—|\/|\bvs\b|\bvs\.\b|\bv\b)\s*/i;

        // Aston Villa vs sorunu: Eğer kullanıcı 'Aston Villa v Chelsea' yazarsa '\bv\b' yakalar.
        // Fakat 'v' için her iki tarafta boşluk veya sınır olmalı. \b yeterli.
        const parts = input.split(safeRegex);
        if (parts.length >= 2 && parts[0].trim() && parts[parts.length - 1].trim()) {
            // Eğer birden fazla ayraç varsa ilk kısmı home, sonrasını birleştirip away yapabiliriz
            // Ama basitçe ilk ayraçtan bölelim.
            const match = input.match(safeRegex);
            if (match) {
                const idx = match.index;
                const h = input.substring(0, idx).trim();
                const a = input.substring(idx + match[0].length).trim();
                if (h && a) return { home: h, away: a };
            }
        }
        return null;
    }

    async function performSearch() {
        let home = homeInput.value.trim();
        let away = awayInput.value.trim();

        // Eğer sadece ev sahibi girildiyse, belki tüm metni oraya yapıştırmıştır.
        if (home && !away) {
            const parsed = parseMatchInput(home);
            if (parsed) {
                home = parsed.home;
                away = parsed.away;
                // UI'ı da güncelle
                homeInput.value = home;
                awayInput.value = away;
            }
        }

        if (!home || !away) {
            showError('Lütfen hem ev sahibi hem de deplasman takımlarını girin veya tek satırda (örn: PSG-Monaco) yazın.');
            return;
        }

        setLoading(true);
        hideError();
        resultsSection.classList.add('hidden');

        try {
            console.log(`[1] USER INPUT\nHome: ${home}\nAway: ${away}`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 45000); // 45s timeout for frontend Mackolik scraper

            const response = await fetch(`/api/fetch-match?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}`, {
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            const data = await response.json();

            if (!response.ok) {
                console.error(`[FETCH ERROR]`, data.error);
                throw new Error(data.error || 'Bilinmeyen bir hata oluştu.');
            }

            console.log(`[10] UI RENDER\nSUCCESS`);
            renderResults(data);
        } catch (err) {
            console.error(`[EXCEPTION]`, err);
            if (err.name === 'AbortError') {
                showError('İstek zaman aşımına uğradı. Lütfen tekrar deneyin.');
            } else {
                showError(err.message);
            }
        } finally {
            setLoading(false);
        }
    }

    function renderResults(data) {
        lastFetchedData = data;

        document.getElementById('match-league').textContent = data.details?.league || 'Bilinmeyen Lig';
        document.getElementById('match-date').textContent = `${data.matchDate} ${data.matchTime || ''}`;
        document.getElementById('match-title').textContent = data.matchName;
        document.getElementById('match-score').textContent = data.confidence ? `%${data.confidence}` : 'N/A';

        const container = document.getElementById('markets-container');
        container.innerHTML = '';
        container.className = 'categories-accordion';

        if (data.isHistorical && !data.hasOdds) {
            container.innerHTML = `<div style="text-align: center; color: var(--accent); padding: 2rem; background: rgba(255, 171, 0, 0.1); border: 1px solid var(--accent); border-radius: 8px; margin-bottom: 1rem;">
                <p style="margin: 0; font-weight: 500;">${data.historicalMessage}</p>
            </div>`;
        } else if (!data.markets || Object.keys(data.markets).length === 0) {
            container.innerHTML = '<div class="no-results">Geçerli maç oranı bulunamadı.</div>';
        } else {
            let isFirstOpen = true;
            for (const [categoryName, markets] of Object.entries(data.markets)) {
                const marketEntries = Object.entries(markets);
                const count = marketEntries.length;

                const itemDiv = document.createElement('div');
                itemDiv.className = `accordion-item ${isFirstOpen && count > 0 ? 'open' : ''}`;

                const headerDiv = document.createElement('div');
                headerDiv.className = 'accordion-header';
                headerDiv.innerHTML = `
                    <div class="accordion-title-group">
                        <span class="accordion-category-name">${categoryName}</span>
                        <span class="accordion-count-badge">${count} Pazar</span>
                        ${count > 0 ? `<button class="btn-single-ai" title="${categoryName} PNG İndir">🖼</button>` : ''}
                    </div>
                    <span class="accordion-arrow">▼</span>
                `;

                const btnSingleAI = headerDiv.querySelector('.btn-single-ai');
                if (btnSingleAI) {
                    btnSingleAI.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        btnSingleAI.textContent = '⏳';
                        btnSingleAI.disabled = true;

                        try {
                            const { createCategoryExportElement, renderElementToPNGBlob, downloadBlob, cleanTeamSlug, categoryToSlug } = await import('./js/aiExportRenderer.js');
                            const matchInfo = lastFetchedData.match;
                            const domEl = createCategoryExportElement(matchInfo, categoryName, markets);
                            if (domEl) {
                                const blob = await renderElementToPNGBlob(domEl);
                                const homeSlug = cleanTeamSlug(matchInfo.home);
                                const awaySlug = cleanTeamSlug(matchInfo.away);
                                const code = matchInfo.code || 'NOCODE';
                                const catSlug = categoryToSlug(categoryName);
                                downloadBlob(blob, `${homeSlug}_vs_${awaySlug}_${code}_${catSlug}.png`);
                            } else {
                                alert('Bu kategoride indirilecek oran bulunamadı.');
                            }
                        } catch (err) {
                            console.error(err);
                            alert('Görsel oluşturulamadı: ' + err.message);
                        } finally {
                            btnSingleAI.textContent = '✓';
                            setTimeout(() => {
                                if (btnSingleAI.textContent === '✓') btnSingleAI.textContent = '🖼';
                                btnSingleAI.disabled = false;
                            }, 2000);
                        }
                    });
                }

                headerDiv.addEventListener('click', () => {
                    itemDiv.classList.toggle('open');
                });

                const bodyDiv = document.createElement('div');
                bodyDiv.className = 'accordion-body';

                if (count === 0) {
                    bodyDiv.innerHTML = '<div class="empty-category">Bu kategoride açık oran bulunamadı.</div>';
                } else {
                    if (isFirstOpen) isFirstOpen = false;

                    for (const [marketName, outcomes] of marketEntries) {
                        const blockDiv = document.createElement('div');
                        blockDiv.className = 'market-block';

                        const titleDiv = document.createElement('div');
                        titleDiv.className = 'market-title';
                        titleDiv.textContent = marketName;
                        blockDiv.appendChild(titleDiv);

                        const gridDiv = document.createElement('div');
                        gridDiv.className = 'outcomes-grid';

                        for (const [outcomeName, oddVal] of Object.entries(outcomes)) {
                            const pill = document.createElement('div');
                            pill.className = 'outcome-pill';
                            pill.innerHTML = `
                                <span class="outcome-name">${outcomeName}</span>
                                <span class="outcome-odd">${oddVal}</span>
                            `;
                            gridDiv.appendChild(pill);
                        }

                        blockDiv.appendChild(gridDiv);
                        bodyDiv.appendChild(blockDiv);
                    }
                }

                itemDiv.appendChild(headerDiv);
                itemDiv.appendChild(bodyDiv);
                container.appendChild(itemDiv);
            }
        }

        resultsSection.classList.remove('hidden');

        // Render Historical Matches
        const histContainer = document.getElementById('historical-matches-container');
        const histSection = document.getElementById('historical-section');
        const fYear = document.getElementById('filter-year');
        const fMonth = document.getElementById('filter-month');
        const fOdds = document.getElementById('filter-odds');

        renderHistoricalMatches({
            historyData: data.history,
            container: histContainer,
            section: histSection,
            filterYearSelect: fYear,
            filterMonthSelect: fMonth,
            filterOddsSelect: fOdds
        });
    }

    function isValidOddValue(val) {
        if (val === null || val === undefined) return false;
        const s = String(val).trim();
        if (s === '' || s === '-' || s === '—' || s === 'null' || s === 'undefined') return false;
        return true;
    }

    async function copyToClipboard() {
        if (!lastFetchedData) return;

        const lines = [];

        // Hiyerarşik markets objesi: { "MAÇ SONUCU": { "Maç Sonucu": { "1": 2.10 } } }
        if (lastFetchedData.markets && typeof lastFetchedData.markets === 'object' && !Array.isArray(lastFetchedData.markets)) {
            for (const [, categoryMarkets] of Object.entries(lastFetchedData.markets)) {
                if (!categoryMarkets || typeof categoryMarkets !== 'object') continue;
                for (const [marketName, outcomes] of Object.entries(categoryMarkets)) {
                    if (!outcomes || typeof outcomes !== 'object') continue;
                    for (const [outcomeName, oddValue] of Object.entries(outcomes)) {
                        if (!isValidOddValue(oddValue)) continue;
                        lines.push(`${marketName} ${outcomeName}: ${String(oddValue).trim()}`);
                    }
                }
            }
        }

        const textToCopy = lines.length > 0 ? lines.join('\n') : 'Geçerli oran bulunamadı.';

        try {
            await navigator.clipboard.writeText(textToCopy);
            const originalText = copyBtn.innerHTML;
            copyBtn.innerHTML = '✅ Kopyalandı!';
            copyBtn.style.color = 'var(--accent)';
            setTimeout(() => {
                copyBtn.innerHTML = originalText;
                copyBtn.style.color = '';
            }, 2000);
        } catch (err) {
            console.error('Kopyalama başarısız:', err);
            alert('Kopyalama işlemi başarısız oldu.');
        }
    }

    function setLoading(isLoading) {
        if (isLoading) {
            btnText.classList.add('hidden');
            btnLoader.classList.remove('hidden');
            searchBtn.disabled = true;
        } else {
            btnText.classList.remove('hidden');
            btnLoader.classList.add('hidden');
            searchBtn.disabled = false;
        }
    }

    function showError(msg) {
        errorMsg.textContent = msg;
        errorMsg.classList.remove('hidden');
    }

    function hideError() {
        errorMsg.classList.add('hidden');
        errorMsg.textContent = '';
    }
});
