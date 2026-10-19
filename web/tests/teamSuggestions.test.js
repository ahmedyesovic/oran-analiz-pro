import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeamSuggestions } from '../frontend/src/utils/teamSuggestions.js';

function setup() {
    let state;
    let now = 0;
    let nextTimer = 0;
    const timers = new Map();
    const calls = [];
    const controller = createTeamSuggestions({
        apiBaseUrl: 'https://example.test',
        onState: value => { state = value; },
        setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, due: now + delay }); return id; },
        clearTimer: id => timers.delete(id),
        fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
            calls.push({ url: new URL(url), signal, reject,
                finish: teams => resolve({ ok: true, json: async () => ({ success: true, teams }) }) });
        })
    });
    return { controller, calls, state: () => state,
        async advance(ms) {
            now += ms;
            for (const [id, timer] of [...timers]) {
                if (timer.due <= now) { timers.delete(id); timer.callback(); }
            }
            await Promise.resolve();
        }
    };
}
const team = { id: 'sahadan:city', name: 'Manchester City', squad: 'main', country: 'England' };
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('suggestions wait for two characters and debounce edits for 300ms', async () => {
    const field = setup();
    field.controller.edit('M');
    await field.advance(400);
    assert.equal(field.calls.length, 0);
    field.controller.edit('Ma');
    await field.advance(299);
    assert.equal(field.calls.length, 0);
    field.controller.edit('Man');
    await field.advance(299);
    assert.equal(field.calls.length, 0);
    await field.advance(1);
    assert.equal(field.calls.length, 1);
    assert.equal(field.calls[0].url.href, 'https://example.test/api/team-search?q=Man');
    field.calls[0].finish([team]);
    await settle();
    assert.equal(field.state().teams[0].name, 'Manchester City');
    field.controller.dispose();
});

test('new edits abort the old suggestion request and ignore late suggestions', async () => {
    const field = setup();
    field.controller.edit('Man');
    await field.advance(300);
    field.controller.edit('Ars');
    assert.equal(field.calls[0].signal.aborted, true);
    await field.advance(300);
    const arsenal = { id: 'sahadan:arsenal', name: 'Arsenal', squad: 'main' };
    field.calls[1].finish([arsenal]);
    await settle();
    field.calls[0].finish([team]);
    await settle();
    assert.deepEqual(field.state().teams, [arsenal]);
    field.controller.dispose();
});

test('keyboard navigation selects an explicit ID and editing clears that identity', async () => {
    const field = setup();
    field.controller.edit('Man');
    await field.advance(300);
    const reserves = { id: 'sahadan:reserves', name: 'Manchester City Res.', squad: 'reserve' };
    field.calls[0].finish([team, reserves]);
    await settle();
    field.controller.navigate(1);
    assert.equal(field.state().activeIndex, 0);
    field.controller.navigate(1);
    assert.equal(field.state().activeIndex, 1);
    assert.equal(field.controller.acceptActive(), true);
    assert.equal(field.state().value, 'Manchester City Res.');
    assert.equal(field.state().selectedId, 'sahadan:reserves');
    assert.equal(field.state().open, false);
    field.controller.edit('Manchester City');
    assert.equal(field.state().selectedId, null);
    field.controller.dispose();
});

test('clear cancels pending work, empties selected identity and rejects late replies', async () => {
    const field = setup();
    field.controller.replace('Manchester City', team.id);
    field.controller.edit('Man');
    await field.advance(300);
    field.controller.clear();
    assert.equal(field.calls[0].signal.aborted, true);
    field.calls[0].finish([team]);
    await settle();
    assert.equal(field.state().value, '');
    assert.equal(field.state().selectedId, null);
    assert.deepEqual(field.state().teams, []);
    assert.equal(field.state().open, false);
    assert.equal(field.state().loading, false);
    field.controller.edit('Ar');
    field.controller.clear();
    await field.advance(300);
    assert.equal(field.calls.length, 1);
    field.controller.dispose();
});

test('fields stay independent, suggestions are capped, and Escape prevents late reopening', async () => {
    const home = setup();
    const away = setup();
    home.controller.edit('Ma');
    away.controller.edit('Ch');
    await home.advance(300);
    await away.advance(300);
    home.calls[0].finish(Array.from({ length: 12 }, (_, i) => ({ id: `team:${i}`, name: `Match ${i}`, squad: 'main' })));
    await settle();
    assert.equal(home.state().teams.length, 8);
    away.controller.dismiss();
    assert.equal(home.calls[0].signal.aborted, false);
    away.calls[0].finish([team]);
    await settle();
    assert.equal(away.state().open, false);
    assert.deepEqual(away.state().teams, []);
    home.controller.dispose();
    away.controller.dispose();
});

test('suggestion failures keep free text usable and selection supports pointer clicks', async () => {
    const field = setup();
    field.controller.edit('Man');
    await field.advance(300);
    field.calls[0].reject(new Error('Provider unavailable'));
    await settle();
    assert.equal(field.state().value, 'Man');
    assert.equal(field.state().selectedId, null);
    assert.equal(field.state().loading, false);
    assert.ok(field.state().error);
    field.controller.edit('Manchester');
    await field.advance(300);
    field.calls[1].finish([team]);
    await settle();
    field.controller.select(team.id);
    assert.equal(field.state().selectedId, team.id);
    assert.equal(field.state().value, 'Manchester City');
    field.controller.dispose();
});

test('keyboard focus scrolls a hidden suggestion into view using only the list scroll position', async () => {
    const { keepSuggestionVisible } = await import('../frontend/src/utils/teamSuggestions.js');
    const list = { scrollTop: 0, clientTop: 1, clientHeight: 300,
        getBoundingClientRect: () => ({ top: 100 }) };
    keepSuggestionVisible(list, { getBoundingClientRect: () => ({ top: 438, bottom: 486 }) });
    assert.equal(list.scrollTop, 85);
    // Arrow-up wrapping from the first row to the eighth must reveal the bottom row.
    list.scrollTop = 85;
    keepSuggestionVisible(list, { getBoundingClientRect: () => ({ top: 55, bottom: 103 }) });
    assert.equal(list.scrollTop, 39);
});

test('an already-visible suggestion leaves the list scroll position unchanged', async () => {
    const { keepSuggestionVisible } = await import('../frontend/src/utils/teamSuggestions.js');
    const list = { scrollTop: 96, clientTop: 1, clientHeight: 300,
        getBoundingClientRect: () => ({ top: 100 }) };
    keepSuggestionVisible(list, { getBoundingClientRect: () => ({ top: 120, bottom: 168 }) });
    assert.equal(list.scrollTop, 96);
});
