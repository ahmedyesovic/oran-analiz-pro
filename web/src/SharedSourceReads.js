import { randomUUID } from 'node:crypto';

// Shares only neutral provider GET bodies; each subscriber owns its cancellation.
export class SharedSourceReads {
    constructor({ limit = 100, capacityError } = {}) {
        this.limit = limit;
        this.capacityError = capacityError;
        this.pending = new Map();
        this.active = new Set();
    }

    invalidate(url) {
        for (const [key, entry] of this.pending) {
            if (entry.url === url) this.pending.delete(key);
        }
    }

    read(key, start, { signal, url, onJoin } = {}) {
        if (signal?.aborted) return Promise.reject(signal.reason);
        let entry = this.pending.get(key);
        if (!entry) {
            if (this.active.size >= this.limit) return Promise.reject(this.capacityError());
            entry = { url, transportId: randomUUID(), controller: new AbortController(), waiters: 0, settled: false };
            this.pending.set(key, entry);
            this.active.add(entry);
            entry.promise = Promise.resolve().then(() => start({ signal: entry.controller.signal, transportId: entry.transportId }))
                .finally(() => {
                    entry.settled = true;
                    this.active.delete(entry);
                    if (this.pending.get(key) === entry) this.pending.delete(key);
                });
            // A worker whose final subscriber left still owns resource cleanup.
            entry.promise.catch(() => {});
        }
        entry.waiters++;
        onJoin?.(entry.transportId);
        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = (settle, value) => {
                if (finished) return;
                finished = true;
                signal?.removeEventListener('abort', abort);
                entry.waiters--;
                if (!entry.waiters && !entry.settled) {
                    if (this.pending.get(key) === entry) this.pending.delete(key);
                    entry.controller.abort(new DOMException('No shared source subscribers remain.', 'AbortError'));
                }
                settle(value);
            };
            const abort = () => finish(reject, signal.reason);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
        });
    }
}
