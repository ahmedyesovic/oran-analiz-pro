import test from 'node:test';
import assert from 'node:assert/strict';
import { ReliabilityStore } from '../src/reliabilityStore.js';
import { TeamDirectory } from '../src/teamDirectory.js';
import { MatchService } from '../src/matchService.js';
import { createApp } from '../server.js';

test('application startup prepares local identities so the first pair lookup does not rebuild the catalogue', async t => {
    const store = new ReliabilityStore();
    t.after(() => store.close());
    const directory = new TeamDirectory({ store, searchProvider: () => assert.fail('startup must stay offline') });
    directory.observe({ source: 'sahadan', providerId: 'elcheid', name: 'Elche' });
    directory.observe({ source: 'sahadan', providerId: 'valenciaid', name: 'Valencia' });
    let catalogueReads = 0;
    const original = store.listRecords.bind(store);
    store.listRecords = namespace => {
        if (namespace === 'team-directory') catalogueReads++;
        return original(namespace);
    };
    const service = new MatchService({ store, directory, nesine: {} });
    createApp({ service, directory, sahadan: {}, pairResolver: { resolve: async () => ({ status: 'preserve' }) } });
    assert.equal(catalogueReads, 1, 'catalogue must be ready before the app can listen');
    assert.equal((await directory.resolve({ name: 'Elche' })).name, 'Elche');
    assert.equal((await directory.resolve({ name: 'Valencia' })).name, 'Valencia');
    assert.equal(catalogueReads, 1, 'first user pair must reuse the prepared catalogue');
});
