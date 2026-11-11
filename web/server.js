import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MatchService, validateQuery } from './src/matchService.js';
import { SahadanScraper } from './src/SahadanScraper.js';
import { SourceError, sourceTraces, withSourceDeadline, withRequestTrace, requestTraceId } from './src/sourceHttp.js';
import { getReliabilityStore } from './src/reliabilityStore.js';
import { getTeamDirectory } from './src/teamDirectory.js';
import { PairVariantResolver } from './src/pairVariantResolver.js';

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ service = new MatchService(), directory = service.directory || getTeamDirectory(),
    sahadan = new SahadanScraper({ store: service.store || getReliabilityStore(), directory }), pairResolver } = {}) {
    const app = express();
    app.use(cors());
    app.use(express.json());
    // Only fixed route names are logged; query strings and team names stay private.
    app.use('/api', (req, res, next) => withRequestTrace(() => {
        const startedAt = Date.now();
        const requestId = requestTraceId();
        const routes = new Set(['/fetch-match', '/current-odds', '/historical-odds', '/head-to-head', '/team-search', '/teams', '/health']);
        const route = routes.has(req.path) ? req.path.slice(1) : 'other';
        res.once('finish', () => {
            if (process.env.NODE_ENV === 'production') console.info(JSON.stringify({
                event: 'api-request', requestId, route, status: res.statusCode,
                elapsedMs: Math.max(0, Date.now() - startedAt)
            }));
        });
        next();
    }));
    // Both panels use the same bounded source-verified squad decision.
    const variants = pairResolver || (typeof sahadan.pairCandidates === 'function' && typeof sahadan.api === 'function'
        && typeof sahadan.detail === 'function' && typeof service.nesine?.current === 'function'
        ? new PairVariantResolver({ sahadan, verifyPrimary: async query => Boolean(await service.nesine.current(query)) })
        : { resolve: async () => ({ status: 'preserve' }) });
    async function resolvePair(query) {
        let choice;
        try { choice = await variants.resolve(query); }
        catch { return { query, warning: null }; }
        if (choice?.status === 'ambiguous') {
            throw new SourceError('Bu adlarla birden fazla takım eşleşiyor. Takım seçimini listeden yapın.', 400);
        }
        if (choice?.status !== 'alternate') return { query, warning: null };
        if (query.homeTeamId || query.awayTeamId || query.matchId || query.date || query.code) return { query, warning: null };
        const identities = choice.teamIds && Object.fromEntries(['home', 'away'].map(side => [side, {
            providers: [{ source: 'sahadan', providerId: choice.teamIds[side] }]
        }]));
        const resolved = { ...query, home: choice.home, away: choice.away,
            ...(identities ? { trustedTeamIdentities: identities,
                trustedSourceMatchId: choice.sourceMatchId, trustedSourceMatchDate: choice.sourceMatchDate } : {}) };
        return { query: resolved, warning: `Kaynakta doğrulanan takımlar: ${choice.home} - ${choice.away}.` };
    }
    app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
    for (const [route, mode] of [['fetch-match', 'auto'], ['current-odds', 'current'], ['historical-odds', 'historical']]) {
        app.get(`/api/${route}`, async (req, res, next) => {
            try {
                const query = validateQuery(req.query, { pairRequired: mode === 'historical' });
                const resolved = mode === 'auto' ? await resolvePair(query) : { query, warning: null };
                const result = await service.lookup(resolved.query, mode);
                res.json(resolved.warning ? { ...result, warnings: [resolved.warning, ...(result.warnings || [])] } : result);
            } catch (error) { next(error); }
        });
    }
    app.get('/api/head-to-head', async (req, res, next) => {
        try {
            const query = validateQuery(req.query, { pairRequired: true });
            const resolved = await resolvePair(query);
            const teams = service.resolveTeams ? await service.resolveTeams(resolved.query) : resolved.query;
            const teamIdentities = resolved.query.trustedTeamIdentities || teams.teamIdentities;
            const result = await sahadan.headToHead(teams.home, teams.away, { teamIdentities });
            res.json(resolved.warning ? { ...result, resolutionWarning: resolved.warning } : result);
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
