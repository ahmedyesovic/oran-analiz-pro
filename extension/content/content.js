/**
 * Content Script - Nesine Sayfasında Çalışır
 * Aktif sayfada açık olan maç kodunu veya takım bilgilerini tespit ederek popup'a yardımcı olur.
 */

(() => {
  // Sayfa URL'sinden maç kodunu kontrol et
  function getMatchCodeFromUrl() {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('code');
    } catch {
      return null;
    }
  }

  // Popup'tan gelen sorguları yanıtla
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'GET_PAGE_MATCH_INFO') {
      const code = getMatchCodeFromUrl();
      sendResponse({
        url: window.location.href,
        code: code ? parseInt(code, 10) : null
      });
    }
  });
})();
