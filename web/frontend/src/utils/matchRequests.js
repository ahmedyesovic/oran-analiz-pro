const systemClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer)
};
const observationLimit = 5 * 60 * 1000;
const requestLimit = 30 * 1000;
const activeRefreshStates = new Set(['queued', 'running', 'backoff']);

class RequestTransportError extends Error {
  constructor(cause) {
    super(cause.message, { cause });
    this.name = cause.name;
  }
}

function retryAfterTime(response, now) {
  const value = response.headers?.get('Retry-After')?.trim();
  if (!value) return now;
  if (/^\d+(?:\.\d+)?$/.test(value)) return now + Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : now;
}

// Odds selection and the source H2H table have independent request lifetimes.
export function createMatchRequests({ apiBaseUrl = '', onMatch, onHistory, onSelection, fetchImpl = fetch, clock = systemClock }) {
  const active = { match: null, history: null };
  const handlers = { match: onMatch, history: onHistory };

  function cancelActiveRequests() {
    for (const kind of Object.keys(active)) {
      const controller = active[kind];
      active[kind] = null;
      controller?.abort();
    }
  }

  // Race the complete response (including JSON parsing), so a fetch that ignores
  // cancellation still cannot update the screen after its request deadline.
  async function fetchOnce(url, controller, deadline, observe) {
    const attempt = new AbortController();
    let timer;
    let onAbort;
    try {
      return await new Promise((resolve, reject) => {
        onAbort = () => {
          attempt.abort(controller.signal.reason);
          reject(controller.signal.reason);
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timer = clock.setTimeout(() => {
          const error = new RequestTransportError(new DOMException('İstek zaman aşımına uğradı.', 'TimeoutError'));
          attempt.abort(error);
          reject(error);
        }, Math.min(requestLimit, Math.max(0, deadline - clock.now())));
        let transport;
        try {
          transport = fetchImpl(url, {
            signal: attempt.signal,
            headers: { 'X-Lookup-Capabilities': 'recovery-v1', ...(observe ? { 'X-Lookup-Intent': 'observe' } : {}) }
          });
        } catch (error) {
          transport = Promise.reject(error);
        }
        Promise.resolve(transport).catch(error => {
          if (error?.name === 'TypeError' || error?.name === 'TimeoutError') throw new RequestTransportError(error);
          throw error;
        }).then(async response => ({ response, data: await response.json() })).then(resolve, reject);
      });
    } finally {
      clock.clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  function wait(controller, delay) {
    if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clock.clearTimeout(timer);
        reject(controller.signal.reason);
      };
      const timer = clock.setTimeout(() => {
        controller.signal.removeEventListener('abort', onAbort);
        resolve();
      }, delay);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function request(kind, path, params) {
    active[kind]?.abort();
    const controller = new AbortController();
    active[kind] = controller;
    const deadline = clock.now() + observationLimit;
    const url = `${apiBaseUrl}/api/${path}?${new URLSearchParams(params)}`;
    const current = () => active[kind] === controller && !controller.signal.aborted;
    let retainedData = null;
    let lastState;
    let observe = false;
    const emit = state => {
      if (current() && (!lastState || Object.keys(state).some(key => state[key] !== lastState[key])
        || Object.keys(lastState).some(key => !(key in state)))) {
        lastState = state;
        handlers[kind](state);
      }
    };
    const finishObservation = () => emit({ data: retainedData, loading: false,
      error: retainedData
        ? 'En yeni maç kontrolü bu oturumda tamamlanamadı; son doğrulanmış arşiv gösteriliyor.'
        : 'Kaynak şu anda doğrulanamıyor. Otomatik kontrol süresi doldu; daha sonra yeniden arayabilirsiniz.' });
    const recoveringState = () => emit({ data: retainedData, loading: !retainedData, error: null,
      message: 'Kaynak geçici olarak kullanılamıyor; otomatik kontrol sürüyor.' });
    emit({ data: null, loading: true, error: null });
    try {
      while (current()) {
        if (clock.now() >= deadline) {
          finishObservation();
          return;
        }
        let result;
        try {
          result = await fetchOnce(url, controller, deadline, observe);
        } catch (error) {
          if (!(error instanceof RequestTransportError) || !current() || clock.now() >= deadline) throw error;
          recoveringState();
          // Until the first API reply, repeat the idempotent start request: the
          // lost connection may have failed before the server could enqueue it.
          await wait(controller, Math.min(5000, Math.max(0, deadline - clock.now())));
          continue;
        }
        let { response, data } = result;
        if (!current()) return;
        if (clock.now() >= deadline) {
          finishObservation();
          return;
        }
        const now = clock.now();
        let nextAttempt;
        let submissionUnacknowledged = false;
        if (!response.ok || !data?.success) {
          if (data?.retryable !== true) throw new Error(data?.error || 'Veri bulunamadı.');
          submissionUnacknowledged = data.refresh == null
            && ['REFRESH_QUEUE_FULL', 'REFRESH_STORAGE_UNAVAILABLE'].includes(data.errorCode);
          nextAttempt = Math.max(now + 5000, retryAfterTime(response, now), Date.parse(data.refresh?.nextAttemptAt) || 0);
          recoveringState();
        } else {
          // Identical polls preserve the H2H data and state references, avoiding
          // unnecessary updates while the source table is being read or scrolled.
          if (retainedData && JSON.stringify(retainedData) === JSON.stringify(data)) data = retainedData;
          retainedData = data;
          emit({ data, loading: false, error: null });
          if (!activeRefreshStates.has(data.refresh?.state)) return;
          nextAttempt = Math.max(now + 10000, Date.parse(data.refresh?.nextAttemptAt) || 0);
        }
        // Failed admission may have created no job. Only its original submitter
        // retries submission; an established observer always remains passive.
        observe = observe || !submissionUnacknowledged;
        await wait(controller, Math.max(0, Math.min(nextAttempt - clock.now(), deadline - clock.now())));
      }
    } catch (error) {
      if (current()) {
        if (clock.now() >= deadline) finishObservation();
        else emit({ data: retainedData, loading: false, error: error.name === 'TimeoutError'
          ? 'İstek zaman aşımına uğradı. Tekrar deneyin.' : error.message });
      }
    }
  }

  return {
    searchPair(home, away, { source = 'mackolik', homeTeamId, awayTeamId } = {}) {
      const identities = { ...(homeTeamId ? { homeTeamId } : {}), ...(awayTeamId ? { awayTeamId } : {}) };
      const query = { home, away, source, ...identities };
      onSelection(query);
      return Promise.allSettled([
        request('match', 'fetch-match', query),
        request('history', 'head-to-head', { home, away, ...identities })
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
