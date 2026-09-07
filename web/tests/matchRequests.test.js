import assert from 'node:assert/strict';
import test from 'node:test';
import { createMatchRequests } from '../frontend/src/utils/matchRequests.js';

function setup() {
    const state = { match: null, history: null, selection: null };
    const calls = [];
    const requests = createMatchRequests({
        onMatch: value => { state.match = value; },
        onHistory: value => { state.history = value; },
        onSelection: value => { state.selection = value; },
        fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
            calls.push({ url: new URL(url, 'http://localhost'), signal,
                finish: data => resolve({ ok: true, json: async () => data }), reject });
        })
    });
    return { state, calls, requests };
}

test('choosing a historical match preserves the original H2H data and makes only an odds request', async () => {
    const { state, calls, requests } = setup();
    const search = requests.searchPair('Genoa', 'Como', { source: 'mackolik' });
    const history = { success: true, sourceMatchId: 'original', matches: [{ id: 'old' }] };
    calls[0].finish({ success: true });
    calls[1].finish(history);
    await search;
    const before = state.history;
    const selection = requests.selectMatch({ id: 'old', home: 'Como', away: 'Genoa', date: '2004-05-29' }, 'mackolik');
    assert.equal(calls.length, 3);
    assert.equal(state.history, before);
    assert.equal(state.history.data, history);
    assert.equal(calls[2].url.pathname, '/api/fetch-match');
    assert.equal(calls[2].url.searchParams.get('matchId'), 'old');
    assert.equal(calls[2].url.searchParams.get('date'), '2004-05-29');
    assert.equal(calls[1].signal.aborted, false);
    calls[2].finish({ success: true, hasOdds: false });
    await selection;
    assert.equal(state.history, before);
    requests.dispose();
});

test('a new pair clears the old table and late replies from older requests cannot replace it', async () => {
    const { state, calls, requests } = setup();
    const first = requests.searchPair('Genoa', 'Como');
    const second = requests.searchPair('Arsenal', 'Chelsea');
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, true);
    assert.deepEqual(state.history, { data: null, loading: true, error: null });
    const fresh = { success: true, matches: ['Arsenal-Chelsea'] };
    calls[2].finish({ success: true, match: 'fresh' });
    calls[3].finish(fresh);
    await second;
    calls[0].finish({ success: true, match: 'stale' });
    calls[1].finish({ success: true, matches: ['stale'] });
    await first;
    assert.equal(state.history.data, fresh);
    assert.equal(state.match.data.match, 'fresh');
    assert.equal(state.selection.home, 'Arsenal');
    requests.dispose();
});

test('H2H failure is independent of odds and does not retain a prior pair table', async () => {
    const { state, calls, requests } = setup();
    const first = requests.searchPair('Genoa', 'Como');
    calls[0].finish({ success: true });
    calls[1].finish({ success: true, matches: ['old-pair'] });
    await first;
    const next = requests.searchPair('Arsenal', 'Chelsea', { source: 'sahadan' });
    calls[2].finish({ success: true, hasOdds: true });
    calls[3].reject(new Error('Sahadan Aralarındaki Maçlar tablosu okunamadı.'));
    await next;
    assert.equal(state.match.data.hasOdds, true);
    assert.equal(state.history.data, null);
    assert.match(state.history.error, /tablosu okunamadı/);
    assert.equal(calls[3].url.searchParams.has('source'), false);
    requests.dispose();
});

test('disposing aborts both requests and ignores their late responses', async () => {
    const { state, calls, requests } = setup();
    const pending = requests.searchPair('Genoa', 'Como');
    requests.dispose();
    assert.equal(calls.every(call => call.signal.aborted), true);
    calls.forEach(call => call.finish({ success: true }));
    await pending;
    assert.equal(state.history.data, null);
    assert.equal(state.match.data, null);
});

test('clearing removes both completed results and the selected pair without another request', async () => {
    const { state, calls, requests } = setup();
    const pending = requests.searchPair('Genoa', 'Como', { source: 'sahadan' });
    calls[0].finish({ success: true, hasOdds: true });
    calls[1].finish({ success: true, matches: ['Genoa-Como'] });
    await pending;
    requests.clear();
    assert.deepEqual(state, {
        match: { data: null, loading: false, error: null },
        history: { data: null, loading: false, error: null },
        selection: null
    });
    assert.equal(calls.length, 2);
});

test('clearing removes errors and is safe to repeat on an empty screen', async () => {
    const { state, calls, requests } = setup();
    const pending = requests.searchPair('Genoa', 'Como');
    calls[0].reject(new Error('Oran sorgusu başarısız.'));
    calls[1].reject(new Error('Geçmiş maç sorgusu başarısız.'));
    await pending;
    assert.ok(state.match.error);
    assert.ok(state.history.error);
    requests.clear();
    requests.clear();
    assert.deepEqual(state, {
        match: { data: null, loading: false, error: null },
        history: { data: null, loading: false, error: null },
        selection: null
    });
    assert.equal(calls.length, 2);
});

test('clearing in flight ignores late success and failure, and a new search still completes', async () => {
    const { state, calls, requests } = setup();
    const old = requests.searchPair('Genoa', 'Como');
    requests.clear();
    assert.equal(calls.every(call => call.signal.aborted), true);
    assert.deepEqual(state, {
        match: { data: null, loading: false, error: null },
        history: { data: null, loading: false, error: null },
        selection: null
    });
    calls[0].finish({ success: true, match: 'stale' });
    calls[1].reject(new Error('Geç gelen hata'));
    await old;
    assert.equal(state.match.data, null);
    assert.equal(state.history.error, null);
    assert.equal(state.selection, null);

    const fresh = requests.searchPair('Arsenal', 'Chelsea', { source: 'sahadan' });
    assert.equal(calls[2].signal.aborted, false);
    assert.equal(calls[3].signal.aborted, false);
    assert.equal(calls[2].url.searchParams.get('source'), 'sahadan');
    calls[2].finish({ success: true, match: 'fresh' });
    calls[3].finish({ success: true, matches: ['Arsenal-Chelsea'] });
    await fresh;
    assert.equal(state.match.data.match, 'fresh');
    assert.deepEqual(state.history.data.matches, ['Arsenal-Chelsea']);
    assert.equal(state.selection.home, 'Arsenal');
    requests.dispose();
});
