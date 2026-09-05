import { formatOddsForClipboard, copyToClipboard } from '../utils/helpers.js';
import { 
  exportAllCategoriesAsPNG, 
  createCategoryExportElement, 
  renderElementToPNGBlob, 
  downloadBlob, 
  categoryToSlug, 
  cleanTeamSlug 
} from '../utils/aiExportRenderer.js';
import { renderHistoricalMatches } from '../utils/historicalUI.js';

// DOM Elementleri
const homeInput = document.getElementById('homeInput');
const awayInput = document.getElementById('awayInput');
const clearHome = document.getElementById('clearHome');
const clearAway = document.getElementById('clearAway');
const btnFetchOdds = document.getElementById('btnFetchOdds');
const btnRefresh = document.getElementById('btnRefresh');
const btnCopyAll = document.getElementById('btnCopyAll');
const btnExportAI = document.getElementById('btnExportAI');
const aiExportProgress = document.getElementById('aiExportProgress');
const aiProgressTitle = document.getElementById('aiProgressTitle');
const aiProgressCount = document.getElementById('aiProgressCount');
const aiProgressFill = document.getElementById('aiProgressFill');

const statusContainer = document.getElementById('statusContainer');
const statusMessage = document.getElementById('statusMessage');
const loadingIndicator = document.getElementById('loadingIndicator');
const resultsContainer = document.getElementById('resultsContainer');

const matchTitle = document.getElementById('matchTitle');
const matchCodeBadge = document.getElementById('matchCodeBadge');
const matchDateTime = document.getElementById('matchDateTime');
const matchConfidence = document.getElementById('matchConfidence');
const categoriesAccordion = document.getElementById('categoriesAccordion');

const tabNotice = document.getElementById('tabNotice');
const tabNoticeText = document.getElementById('tabNoticeText');
const btnUseTabCode = document.getElementById('btnUseTabCode');

const debugToggle = document.getElementById('debugToggle');
const debugHeader = document.getElementById('debugHeader');
const debugLogsContent = document.getElementById('debugLogsContent');
const debugLogsText = document.getElementById('debugLogsText');
const toast = document.getElementById('toast');

let currentParsedData = null;
let detectedTabMatchCode = null;

// ==========================================
// Başlangıç Yüklemesi
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
  // Kaydedilmiş son aramayı geri yükle
  chrome.storage.local.get(['lastHome', 'lastAway', 'debugMode'], (res) => {
    if (res.lastHome) homeInput.value = res.lastHome;
    if (res.lastAway) awayInput.value = res.lastAway;
    if (res.debugMode !== undefined) {
      debugToggle.checked = res.debugMode;
    }
  });



  // Aktif sekmede açık bir Nesine maçı var mı kontrol et
  checkCurrentTabMatch();
});

// ==========================================
// Olay Dinleyicileri
// ==========================================
clearHome.addEventListener('click', () => {
  homeInput.value = '';
  homeInput.focus();
});

clearAway.addEventListener('click', () => {
  awayInput.value = '';
  awayInput.focus();
});

homeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') awayInput.focus();
});

awayInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleFetchClick();
});

btnFetchOdds.addEventListener('click', () => handleFetchClick(false));
btnRefresh.addEventListener('click', () => handleFetchClick(true));

btnCopyAll.addEventListener('click', async () => {
  if (!currentParsedData) return;
  const formattedText = formatOddsForClipboard(currentParsedData);
  const ok = await copyToClipboard(formattedText);
  if (ok) {
    showToast('Tüm oranlar panoya kopyalandı!');
  } else {
    showToast('Kopyalama başarısız oldu!');
  }
});

btnExportAI.addEventListener('click', async () => {
  if (!currentParsedData) return;
  
  btnExportAI.disabled = true;
  aiExportProgress.classList.remove('hidden');
  aiProgressTitle.textContent = 'Görseller hazırlanıyor...';
  aiProgressCount.textContent = '0/8';
  aiProgressFill.style.width = '0%';

  try {
    const files = await exportAllCategoriesAsPNG({
      match: currentParsedData.match,
      categories: currentParsedData.markets,
      onProgress: ({ current, total, categoryName }) => {
        aiProgressTitle.textContent = `${categoryName}...`;
        aiProgressCount.textContent = `${current}/${total}`;
        const pct = Math.round((current / total) * 100);
        aiProgressFill.style.width = `${pct}%`;
      }
    });

    aiProgressTitle.textContent = `Tamamlandı (${files.length} PNG)`;
    showToast(`${files.length} adet AI uyumlu PNG başarıyla indirildi!`);
    setTimeout(() => {
      aiExportProgress.classList.add('hidden');
    }, 3500);
  } catch (err) {
    console.error('AI Export Hatası:', err);
    aiProgressTitle.textContent = 'Hata oluştu!';
    showToast('Görsel üretilirken hata oluştu: ' + err.message);
  } finally {
    btnExportAI.disabled = false;
  }
});

debugHeader.addEventListener('click', () => {
  debugLogsContent.classList.toggle('hidden');
});

debugToggle.addEventListener('change', () => {
  chrome.storage.local.set({ debugMode: debugToggle.checked });
});

btnUseTabCode.addEventListener('click', () => {
  if (detectedTabMatchCode) {
    handleFetchClick(false, detectedTabMatchCode);
  }
});

// ==========================================
// Aktif Sekme Tespiti
// ==========================================
async function checkCurrentTabMatch() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'DETECT_CURRENT_TAB_MATCH' });
    if (response && response.success && response.data && response.data.code) {
      detectedTabMatchCode = response.data.code;
      tabNoticeText.textContent = `Açık sayfada maç tespit edildi: #${detectedTabMatchCode}`;
      tabNotice.classList.remove('hidden');
    }
  } catch (e) {
    // Sekme kontrolü opsiyoneldir
  }
}

function parseMatchInput(input) {
  if (!input) return null;
  const safeRegex = /\s*(?:-|–|—|\/|\bvs\b|\bvs\.\b|\bv\b)\s*/i;
  const parts = input.split(safeRegex);
  if (parts.length >= 2 && parts[0].trim() && parts[parts.length-1].trim()) {
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

// ==========================================
// Veri Çekme Akışı
// ==========================================
async function handleFetchClick(forceRefresh = false, directCode = null) {
  let home = homeInput.value.trim();
  let away = awayInput.value.trim();

  // Eğer sadece ev sahibi girildiyse, tüm metni parse et
  if (home && !away) {
    const parsed = parseMatchInput(home);
    if (parsed) {
      home = parsed.home;
      away = parsed.away;
      homeInput.value = home;
      awayInput.value = away;
    }
  }

  if (!directCode && (!home || !away)) {
    showStatus('Lütfen hem ev sahibi hem de deplasman takımını giriniz veya tek satırda (örn: PSG-Monaco) yazınız.', 'error');
    return;
  }

  // Son aramayı sakla
  if (!directCode) {
    chrome.storage.local.set({ lastHome: home, lastAway: away });
  }

  hideStatus();
  resultsContainer.classList.add('hidden');
  loadingIndicator.classList.remove('hidden');
  btnFetchOdds.disabled = true;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000); // 12s timeout
    
    // In background script, we can't easily pass AbortSignal through chrome.runtime.sendMessage,
    // so we just rely on the background script's own timeout or this local timeout wrapper if we wanted.
    // For sendMessage, we can just use a generic timeout promise.
    
    const sendMessagePromise = new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'FETCH_MATCH_ODDS',
        home,
        away,
        code: directCode,
        debug: debugToggle.checked,
        forceRefresh
      }, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('İstek zaman aşımına uğradı. (Geçmiş maç taraması uzun sürebilir)')), 45000)
    );

    const response = await Promise.race([sendMessagePromise, timeoutPromise]);

    if (!response || !response.success) {
      showStatus(response?.error || 'Bağlantı hatası oluştu. Lütfen tekrar deneyiniz.', 'error');
      return;
    }

    const payload = response.data;

    // Debug loglarını panele dök
    if (payload.result?.metadata?.debugLogs) {
      debugLogsText.textContent = payload.result.metadata.debugLogs.join('\n');
    }

    if (!payload.found) {
      showStatus('Maç bulunamadı. Takım isimlerini kontrol ediniz.', 'error');
      return;
    }

    // Başarıyla bulunan maçı ekrana çiz
    renderMatchResults(payload.result);

  } catch (err) {
    showStatus(`Beklenmeyen bir hata oluştu: ${err.message}`, 'error');
  } finally {
    loadingIndicator.classList.add('hidden');
    btnFetchOdds.disabled = false;
  }
}

// ==========================================
// Sonuçları Arayüze Çizme
// ==========================================
function renderMatchResults(data) {
  currentParsedData = data;
  const match = data.match || {};

  // Güvenli Takım İsimleri (null/undefined toUpperCase çökmesini önle)
  const homeRaw = typeof match.home === 'string' ? match.home : (match.name ? match.name.split('-')[0].trim() : (data.matchName ? data.matchName.split('-')[0].trim() : ''));
  const awayRaw = typeof match.away === 'string' ? match.away : (match.name ? match.name.split('-')[1]?.trim() : (data.matchName ? data.matchName.split('-')[1]?.trim() : ''));

  const homeStr = (homeRaw || 'EV SAHİBİ').toUpperCase();
  const awayStr = (awayRaw || 'DEPLASMAN').toUpperCase();

  // match objesini her zaman home ve away ile garanti altına al
  match.home = homeRaw || homeStr;
  match.away = awayRaw || awayStr;
  match.name = match.name || `${homeStr} - ${awayStr}`;

  // Başlık Alanı
  matchTitle.textContent = `${homeStr} - ${awayStr}`;
  matchCodeBadge.textContent = match.code ? `Kod: ${match.code}` : (data.matchCode ? `Kod: ${data.matchCode}` : 'Kodsuz');
  matchDateTime.textContent = `📅 ${match.date || data.matchDate || ''} ${match.time || data.matchTime || ''}`.trim();
  
  if (match.matchedQuery?.confidence) {
    const confPercent = Math.round(match.matchedQuery.confidence * 100);
    matchConfidence.textContent = `🎯 %${confPercent} Eşleşme`;
  } else {
    matchConfidence.textContent = '';
  }

  // Accordion Alanı
  categoriesAccordion.innerHTML = '';
  
  const isHistoricalNoOdds = (data.isHistorical || match.isHistorical) && (!data.hasOdds && !match.hasOdds);

  if (isHistoricalNoOdds) {
      categoriesAccordion.innerHTML = `<div style="text-align: center; color: var(--accent); padding: 1.5rem; background: rgba(255, 171, 0, 0.1); border: 1px solid var(--accent); border-radius: 6px; margin-bottom: 1rem; font-size: 13px;">
          <p style="margin: 0; font-weight: 500;">${data.historicalMessage || match.historicalMessage || 'Bu maça ait Nesine oran verisi artık erişilebilir değil.'}</p>
      </div>`;
  }
 else if (!data.markets || Object.keys(data.markets).length === 0) {
      categoriesAccordion.innerHTML = `<div style="color: #6b7280; font-size: 12px; font-style: italic; padding: 10px; text-align: center;">Açık oran bulunamadı.</div>`;
  } else {
      const categories = data.markets;
      let isFirstOpen = true;

      for (const [categoryName, markets] of Object.entries(categories)) {
        const marketEntries = Object.entries(markets);
        const count = marketEntries.length;

    // Eğer kategoride hiç pazar bulunamadıysa bile kategori görünür, içi boş/mevcut değil uyarısı verir
    const itemDiv = document.createElement('div');
    itemDiv.className = `accordion-item ${isFirstOpen && count > 0 ? 'open' : ''}`;

    const headerDiv = document.createElement('div');
    headerDiv.className = 'accordion-header';
    headerDiv.innerHTML = `
      <div class="accordion-title-group">
        <span class="accordion-category-name">${categoryName}</span>
        <span class="accordion-count-badge">${count} Pazar</span>
        ${count > 0 ? `<button class="btn-single-cat-ai" title="${categoryName} kategorisini tekil AI PNG olarak indir">📷</button>` : ''}
      </div>
      <span class="accordion-arrow">▼</span>
    `;

    // Tekil kategori indirme butonu
    const singleAiBtn = headerDiv.querySelector('.btn-single-cat-ai');
    if (singleAiBtn) {
      singleAiBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        singleAiBtn.textContent = '⏳';
        singleAiBtn.disabled = true;
        try {
          const domEl = createCategoryExportElement(data.match, categoryName, markets);
          if (domEl) {
            const blob = await renderElementToPNGBlob(domEl);
            const homeSlug = cleanTeamSlug(data.match?.home || homeStr);
            const awaySlug = cleanTeamSlug(data.match?.away || awayStr);
            const code = data.match?.code || 'NOCODE';
            const catSlug = categoryToSlug(categoryName);
            downloadBlob(blob, `${homeSlug}_vs_${awaySlug}_${code}_${catSlug}.png`);
            showToast(`${categoryName} PNG indirildi!`);
          }
        } catch (err) {
          showToast('Hata: ' + err.message);
        } finally {
          singleAiBtn.textContent = '📷';
          singleAiBtn.disabled = false;
        }
      });
    }

    headerDiv.addEventListener('click', () => {
      itemDiv.classList.toggle('open');
    });

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'accordion-body';

    if (count === 0) {
      bodyDiv.innerHTML = `<div style="color: #6b7280; font-size: 11px; font-style: italic;">Bu kategoride açık oran bulunamadı.</div>`;
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
          pill.title = `${marketName} - ${outcomeName}: ${oddVal}`;
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
    categoriesAccordion.appendChild(itemDiv);
  }
  }

  resultsContainer.classList.remove('hidden');
  
  // Geçmiş Maçları Render Et
  const histContainer = document.getElementById('historicalMatchesContainer');
  const histSection = document.getElementById('historicalSection');
  const fYear = document.getElementById('filterYear');
  const fMonth = document.getElementById('filterMonth');
  const fOdds = document.getElementById('filterOdds');
  
  if (data.isHistorical) {
      histSection.classList.add('hidden');
  } else {
      renderHistoricalMatches({
          historyData: data.history,
          container: histContainer,
          section: histSection,
          filterYearSelect: fYear,
          filterMonthSelect: fMonth,
          filterOddsSelect: fOdds
      });
  }
}

// ==========================================
// Bildirim ve Toast Fonksiyonları
// ==========================================
function showStatus(msg, type = 'info') {
  statusMessage.textContent = msg;
  statusContainer.className = `status-container status-${type}`;
  statusContainer.classList.remove('hidden');
}

function hideStatus() {
  statusContainer.classList.add('hidden');
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 2200);
}
