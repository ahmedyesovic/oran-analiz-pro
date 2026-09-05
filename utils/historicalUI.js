import { formatOddsForClipboard, copyToClipboard } from './helpers.js';
import { 
    exportAllCategoriesAsPNG, 
    createCategoryExportElement, 
    renderElementToPNGBlob, 
    downloadBlob, 
    categoryToSlug, 
    cleanTeamSlug 
} from './aiExportRenderer.js';

function isValidOdd(val) {
    if (val === null || val === undefined) return false;
    const s = String(val).trim();
    if (s === '' || s === '-' || s === '—' || s === 'null' || s === 'undefined') return false;
    return true;
}

/**
 * Renders the historical matches into the given container.
 * Also sets up the filters.
 */
export function renderHistoricalMatches({
    historyData, 
    container, 
    section, 
    filterYearSelect, 
    filterMonthSelect, 
    filterOddsSelect
}) {
    if (!section || !container) return;

    container.innerHTML = '';
    section.classList.remove('hidden');

    if (!historyData || Object.keys(historyData).length === 0) {
        container.innerHTML = '<div class="historical-no-odds" style="margin-top: 1rem;">Nesine üzerinde bu karşılaşmaya ait geçmiş oran verisi bulunamadı.</div>';
        return;
    }

    // Populate Year Filter
    const years = Object.keys(historyData).sort((a, b) => b - a);
    let yearOptions = '<option value="all">Tümü</option>';
    years.forEach(y => {
        yearOptions += `<option value="${y}">${y}</option>`;
    });
    if (filterYearSelect) filterYearSelect.innerHTML = yearOptions;

    // Filter Logic
    function updateFiltersAndRender() {
        const selectedYear = filterYearSelect ? filterYearSelect.value : 'all';
        const selectedMonth = filterMonthSelect ? filterMonthSelect.value : 'all';
        const selectedOdds = filterOddsSelect ? filterOddsSelect.value : 'all';

        // Update Month Options based on Selected Year
        if (filterYearSelect && filterMonthSelect) {
            let availableMonths = new Set();
            if (selectedYear === 'all') {
                years.forEach(y => Object.keys(historyData[y]).forEach(m => availableMonths.add(m)));
            } else if (historyData[selectedYear]) {
                Object.keys(historyData[selectedYear]).forEach(m => availableMonths.add(m));
            }
            
            const prevSelectedMonth = filterMonthSelect.value;
            let monthOptions = '<option value="all">Tümü</option>';
            Array.from(availableMonths).forEach(m => {
                monthOptions += `<option value="${m}">${m}</option>`;
            });
            filterMonthSelect.innerHTML = monthOptions;
            if (availableMonths.has(prevSelectedMonth)) {
                filterMonthSelect.value = prevSelectedMonth;
            }
        }

        // Render matching data
        container.innerHTML = '';
        let matchCount = 0;

        for (const year of years) {
            if (selectedYear !== 'all' && year !== selectedYear) continue;

            const yearBlock = document.createElement('div');
            yearBlock.className = 'historical-year-block';
            
            const yearTitle = document.createElement('div');
            yearTitle.className = 'historical-year-title';
            yearTitle.textContent = `▼ ${year}`;
            yearTitle.style.cursor = 'pointer';
            yearTitle.addEventListener('click', () => {
                const content = yearBlock.querySelector('.historical-year-content');
                if(content) {
                    content.classList.toggle('hidden');
                    yearTitle.textContent = content.classList.contains('hidden') ? `▶ ${year}` : `▼ ${year}`;
                }
            });
            yearBlock.appendChild(yearTitle);

            const yearContent = document.createElement('div');
            yearContent.className = 'historical-year-content';

            const months = Object.keys(historyData[year]);
            let yearHasMatches = false;

            for (const month of months) {
                if (filterMonthSelect && filterMonthSelect.value !== 'all' && month !== filterMonthSelect.value) continue;

                const monthBlock = document.createElement('div');
                monthBlock.className = 'historical-month-block';
                
                const monthTitle = document.createElement('div');
                monthTitle.className = 'historical-month-title';
                monthTitle.textContent = `▼ ${month}`;
                monthTitle.style.cursor = 'pointer';
                monthTitle.addEventListener('click', () => {
                    const content = monthBlock.querySelector('.historical-month-content');
                    if(content) {
                        content.classList.toggle('hidden');
                        monthTitle.textContent = content.classList.contains('hidden') ? `▶ ${month}` : `▼ ${month}`;
                    }
                });
                monthBlock.appendChild(monthTitle);

                const monthContent = document.createElement('div');
                monthContent.className = 'historical-month-content';

                const matches = historyData[year][month];
                let monthHasMatches = false;

                for (const match of matches) {
                    if (selectedOdds === 'has_odds' && !match.hasOdds) continue;
                    if (selectedOdds === 'no_odds' && match.hasOdds) continue;

                    monthHasMatches = true;
                    yearHasMatches = true;
                    matchCount++;

                    const matchCard = document.createElement('div');
                    matchCard.className = 'historical-match-card';
                    
                    const metaDiv = document.createElement('div');
                    metaDiv.className = 'historical-match-meta';
                    metaDiv.innerHTML = `<span>${match.date}</span><span>ID: ${match.nesineMatchId}</span>`;

                    const teamsDiv = document.createElement('div');
                    teamsDiv.className = 'historical-match-teams';
                    teamsDiv.innerHTML = `${match.home} <span class="historical-match-score">${match.score}</span> ${match.away}`;

                    matchCard.appendChild(metaDiv);
                    matchCard.appendChild(teamsDiv);

                    if (!match.hasOdds) {
                        const noOddsMsg = document.createElement('div');
                        noOddsMsg.className = 'historical-no-odds';
                        noOddsMsg.textContent = 'Nesine üzerinde bu karşılaşmaya ait geçmiş oran verisi bulunamadı.';
                        matchCard.appendChild(noOddsMsg);
                    } else {
                        const hasOddsMsg = document.createElement('div');
                        hasOddsMsg.className = 'historical-has-odds-msg';
                        hasOddsMsg.textContent = '✓ Nesine Oranı';
                        if (match.dataSource === 'mackolik') {
                            hasOddsMsg.textContent = '✓ Nesine Oranı (Mackolik Arşivi)';
                            hasOddsMsg.title = 'Oranlar Mackolik arşivi üzerinden sağlanmıştır ancak bahis sağlayıcısı olarak Nesine.com teyit edilmiştir.';
                        }
                        hasOddsMsg.style.color = '#10b981';
                        hasOddsMsg.style.fontSize = '0.75rem';
                        hasOddsMsg.style.marginBottom = '0.5rem';
                        matchCard.appendChild(hasOddsMsg);

                        const viewBtn = document.createElement('button');
                        viewBtn.className = 'historical-view-odds-btn btn-secondary';
                        viewBtn.textContent = 'Oranları Gör';
                        viewBtn.style.width = '100%';
                        viewBtn.style.padding = '0.5rem';
                        viewBtn.style.marginTop = '0.5rem';
                        
                        const oddsContainer = document.createElement('div');
                        oddsContainer.className = 'historical-odds-container hidden';
                        oddsContainer.style.marginTop = '1rem';
                        
                        viewBtn.addEventListener('click', () => {
                            const isHidden = oddsContainer.classList.contains('hidden');
                            if (isHidden) {
                                oddsContainer.classList.remove('hidden');
                                viewBtn.textContent = 'Oranları Gizle';
                                renderHistoricalOdds(match, oddsContainer);
                            } else {
                                oddsContainer.classList.add('hidden');
                                viewBtn.textContent = 'Oranları Gör';
                            }
                        });

                        matchCard.appendChild(viewBtn);
                        matchCard.appendChild(oddsContainer);
                    }

                    monthContent.appendChild(matchCard);
                }
                
                if (monthHasMatches) {
                    monthBlock.appendChild(monthContent);
                    yearContent.appendChild(monthBlock);
                }
            }

            if (yearHasMatches) {
                yearBlock.appendChild(yearContent);
                container.appendChild(yearBlock);
            }
        }

        // Update title with count
        const sectionTitle = section.querySelector('h2');
        if (sectionTitle) {
            sectionTitle.textContent = `GEÇMİŞ KARŞILAŞMALAR — ${matchCount} Maç`;
        }
    }

    // Attach listeners
    if (filterYearSelect) filterYearSelect.addEventListener('change', updateFiltersAndRender);
    if (filterMonthSelect) filterMonthSelect.addEventListener('change', updateFiltersAndRender);
    if (filterOddsSelect) filterOddsSelect.addEventListener('change', updateFiltersAndRender);

    // Initial render
    updateFiltersAndRender();
}

function renderHistoricalOdds(match, container) {
    container.innerHTML = '';
    
    // Copy All Button
    const topBar = document.createElement('div');
    topBar.style.display = 'flex';
    topBar.style.justifyContent = 'flex-end';
    topBar.style.marginBottom = '1rem';
    
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-secondary copy-btn';
    copyBtn.innerHTML = '📋 Tüm Oranları Kopyala';
    copyBtn.addEventListener('click', async () => {
        // COPY = Pazar + Seçenek: Oran (metadata yok, boş oranlar yok)
        const lines = [];
        for (const [category, options] of Object.entries(match.markets)) {
            for (const [marketName, odds] of Object.entries(options)) {
                for (const [name, value] of Object.entries(odds)) {
                    if (!isValidOdd(value)) continue;
                    lines.push(`${marketName} ${name}: ${String(value).trim()}`);
                }
            }
        }
        const textToCopy = lines.join('\n');
        if (!textToCopy) return;
        
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
        }
    });
    
    topBar.appendChild(copyBtn);
    container.appendChild(topBar);

    for (const [category, options] of Object.entries(match.markets)) {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'accordion-item open';

        const headerDiv = document.createElement('div');
        headerDiv.className = 'accordion-header';

        const leftSide = document.createElement('div');
        leftSide.className = 'accordion-title';
        leftSide.textContent = category;
        headerDiv.appendChild(leftSide);

        const actionsDiv = document.createElement('div');
        actionsDiv.style.display = 'flex';
        actionsDiv.style.gap = '0.5rem';
        actionsDiv.style.alignItems = 'center';

        const btnSingleAI = document.createElement('button');
        btnSingleAI.className = 'btn-ai-single';
        btnSingleAI.innerHTML = '🖼';
        btnSingleAI.title = 'Sadece bu pazarı PNG olarak indir';
        
        btnSingleAI.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                btnSingleAI.disabled = true;
                btnSingleAI.textContent = '...';
                
                // createCategoryExportElement(match, categoryName, markets) formatına uygun obje oluştur
                const exportEl = createCategoryExportElement(match, category, options);
                if (!exportEl) {
                    alert('Bu kategoride indirilecek açık oran bulunamadı.');
                    return;
                }
                const blob = await renderElementToPNGBlob(exportEl);
                if (blob) {
                    const homeSlug = cleanTeamSlug(match.home);
                    const awaySlug = cleanTeamSlug(match.away);
                    const catSlug = categoryToSlug(category);
                    downloadBlob(blob, `gecmis_${homeSlug}_vs_${awaySlug}_${match.date}_${catSlug}.png`);
                }
            } catch (err) {
                console.error(err);
                alert('Görsel oluşturulamadı: ' + err.message);
            } finally {
                btnSingleAI.textContent = '✓';
                setTimeout(() => {
                    if(btnSingleAI.textContent === '✓') btnSingleAI.textContent = '🖼';
                    btnSingleAI.disabled = false;
                }, 2000);
            }
        });

        actionsDiv.appendChild(btnSingleAI);
        
        const arrowSpan = document.createElement('span');
        arrowSpan.className = 'accordion-icon';
        actionsDiv.appendChild(arrowSpan);
        
        headerDiv.appendChild(actionsDiv);

        headerDiv.addEventListener('click', () => {
            itemDiv.classList.toggle('open');
        });

        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'accordion-body';

        for (const [marketName, odds] of Object.entries(options)) {
            const blockDiv = document.createElement('div');
            blockDiv.className = 'market-block';

            const titleDiv = document.createElement('div');
            titleDiv.className = 'market-title';
            titleDiv.textContent = marketName;
            blockDiv.appendChild(titleDiv);

            const gridDiv = document.createElement('div');
            gridDiv.className = 'outcomes-grid';

            for (const [outcomeName, oddVal] of Object.entries(odds)) {
                if (!isValidOdd(oddVal)) continue;
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

        itemDiv.appendChild(headerDiv);
        itemDiv.appendChild(bodyDiv);
        container.appendChild(itemDiv);
    }
}
