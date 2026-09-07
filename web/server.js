import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MatchService, validateQuery } from './src/matchService.js';
import { SahadanScraper } from './src/SahadanScraper.js';
import { sourceTraces } from './src/sourceHttp.js';

const directory = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ service = new MatchService(), sahadan = new SahadanScraper() } = {}) {
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
            const { home, away } = validateQuery(req.query, { pairRequired: true });
            res.json(await sahadan.headToHead(home, away));
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
        res.status(error.status || 502).json({ success: false, status: 'ERROR', error: error.message });
    });
    const dist = path.join(directory, 'frontend', 'dist');
    app.use(express.static(fs.existsSync(dist) ? dist : path.join(directory, 'public')));
    return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = process.env.PORT || 3000;
    createApp().listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Local backend: http://localhost:${port}`));
}
