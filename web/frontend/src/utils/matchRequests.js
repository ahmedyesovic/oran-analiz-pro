// Odds selection and the source H2H table have independent request lifetimes.
export function createMatchRequests({ apiBaseUrl = '', onMatch, onHistory, onSelection, fetchImpl = fetch }) {
  const active = { match: null, history: null };
  const handlers = { match: onMatch, history: onHistory };

  function cancelActiveRequests() {
    for (const kind of Object.keys(active)) {
      const controller = active[kind];
      active[kind] = null;
      controller?.abort();
    }
  }

  async function request(kind, path, params) {
    active[kind]?.abort();
    const controller = new AbortController();
    active[kind] = controller;
    handlers[kind]({ data: null, loading: true, error: null });
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
      const response = await fetchImpl(`${apiBaseUrl}/api/${path}?${new URLSearchParams(params)}`, { signal });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Veri bulunamadı.');
      if (active[kind] === controller) handlers[kind]({ data, loading: false, error: null });
    } catch (error) {
      if (active[kind] === controller && !controller.signal.aborted) {
        handlers[kind]({ data: null, loading: false, error: error.name === 'TimeoutError'
          ? 'İstek zaman aşımına uğradı. Tekrar deneyin.' : error.message });
      }
    }
  }

  return {
    searchPair(home, away, { source = 'mackolik' } = {}) {
      const query = { home, away, source };
      onSelection(query);
      return Promise.allSettled([
        request('match', 'fetch-match', query),
        request('history', 'head-to-head', { home, away })
      ]);
    },
    selectMatch(match, source = 'mackolik') {
      const query = { home: match.home, away: match.away, source, date: match.date, matchId: match.id };
      onSelection(query);
      return request('match', 'fetch-match', query);
    },
    clear() {
      cancelActiveRequests();
      onMatch({ data: null, loading: false, error: null });
      onHistory({ data: null, loading: false, error: null });
      onSelection(null);
    },
    dispose: cancelActiveRequests
  };
}
