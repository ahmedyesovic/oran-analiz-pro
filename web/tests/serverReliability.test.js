import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server.js';

test('API startup supports a team directory alongside the static frontend directory', () => {
    assert.doesNotThrow(() => createApp({ directory: { search: async () => [], resolve: async () => null } }));
});
