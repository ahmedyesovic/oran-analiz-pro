import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MatchService, validateQuery } from './src/matchService.js';
import { SahadanScraper } from './src/SahadanScraper.js';
import { SourceError, sourceTraces, withSourceDeadline } from './src/sourceHttp.js';
import { getReliabilityStore } from './src/reliabilityStore.js';
import { getTeamDirectory } from './src/teamDirectory.js';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ service = new MatchService(), directory = service.directory || getTeamDirectory(),
    sahadan = new SahadanScraper({ store: service.store || getReliabilityStore(), directory }) } = {}) {
    const app = express();
    app.use(cors());
    app.use(express.json());
    app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
    for (const [route, mode] of [['fetch-match', 'auto'], ['current-odds', 'current'], ['historical-odds', 'historical']]) {
        app.get(`/api/${route}`, async (req, res, next) => {
            try {
                const query = validateQuery(req.query, { pairRequired: mode === 'historical' });
                res.json(await service.lookup(query, mode));
            } catch (error) { next(error); }
        });
    }
    app.get('/api/head-to-head', async (req, res, next) => {
        try {
            const query = validateQuery(req.query, { pairRequired: true });
            const { home, away, teamIdentities } = service.resolveTeams ? await service.resolveTeams(query) : query;
            res.json(await sahadan.headToHead(home, away, { teamIdentities }));
        } catch (error) { next(error); }
    });
    app.get('/api/team-search', async (req, res, next) => {
        try {
            if (typeof req.query.q !== 'string' || req.query.q.length > 120) throw new SourceError('Geçersiz takım araması.', 400);
            const q = req.query.q.trim();
            const teams = q.length < 2 ? [] : await withSourceDeadline(() => directory.search(q), { timeoutMs: 12000 });
            res.json({ success: true, teams });
        } catch (error) { next(error); }
    });
    app.get('/api/teams', async (_req, res, next) => {
        try {
            const events = await service.nesine.bulletin();
            res.json({ success: true, teams: [...new Set(events.filter(e => e.TYPE === 1).flatMap(e => [e.HN, e.AN]).filter(Boolean))].sort() });
        } catch (error) { next(error); }
    });
    app.get('/api/debug/:source', (req, res) => {
        if (process.env.NODE_ENV === 'production' || process.env.LOCAL_DEBUG !== '1' || !['nesine', 'mackolik', 'sahadan'].includes(req.params.source)) return res.sendStatus(404);
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.sendStatus(403);
        res.json({ source: req.params.source, responses: sourceTraces(req.params.source) });
    });
    app.use('/api', (_req, res) => res.status(404).json({ success: false, error: 'API bulunamadı.' }));
    app.use((error, _req, res, _next) => {
        console.error(`[API] ${error.message}`);
        if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
        const errorCode = error.retryAfter ? 'RATE_LIMITED' : error.status === 504 ? 'TIMEOUT'
            : error.status === 400 ? 'INVALID_QUERY' : error.status === 404 ? 'NOT_FOUND' : 'PROVIDER_UNAVAILABLE';
        res.status(error.status || 502).json({ success: false, status: 'ERROR', error: error.message, errorCode });
    });
    const dist = path.join(serverDirectory, 'frontend', 'dist');
    app.use(express.static(fs.existsSync(dist) ? dist : path.join(serverDirectory, 'public')));
    return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = process.env.PORT || 3000;
    createApp().listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Local backend: http://localhost:${port}`));
}
