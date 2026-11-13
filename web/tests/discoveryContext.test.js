import assert from 'node:assert/strict';
import test from 'node:test';
import { SahadanScraper } from '../src/SahadanScraper.js';
import { ReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';
import * as http from '../src/sourceHttp.js';
const turn = () => new Promise(resolve => setImmediate(resolve));
const row = (id='contextmatch') => ({ uuid:id, slug:'genoa-vs-como', team_A:{uuid:'genoateam',name:'Genoa'}, team_B:{uuid:'comoteam',name:'Como'}, date_time_utc:'2026-10-29 19:45:00', status:'Played', fts_A:0, fts_B:2, extras:{iddaa_code:123}, ignoredLargeBody:{secret:'must not survive'} });
function html(value) {
    const table=[];
    const add=value => { const index=table.length; table.push(null); table[index]=value && typeof value==='object' ? Object.fromEntries(Object.entries(value).map(([key,v])=>[key,add(v)])) : value; return index; };
    add({data:{schedule:{match:value}}}); return `<script id="__NUXT_DATA__">${JSON.stringify(table)}</script>`;
}
function fixture(t) {
    const store=new ReliabilityStore(); configureReliabilityStore(store); t.after(()=>{configureReliabilityStore(null);store.close();}); return store;
}
test('two Sahadan instances sharing a store reuse one successful pair discovery', async t => {
    const store=fixture(t); const a=new SahadanScraper({store}); const b=new SahadanScraper({store}); let searches=0;
    for (const scraper of [a,b]) scraper.api=async()=>{searches++;return {data:[{type:1,uuid:'genoateam',name:'Genoa'}]};};
    t.mock.method(globalThis,'fetch',async()=>new Response(html(row())));
    const first=await a.pairCandidates('Genoa','Como'); const second=await b.pairCandidates('Genoa','Como');
    assert.equal(searches,1); assert.equal(first[0].uuid,second[0].uuid); assert.equal(second[0].fts_A,0);
    const context=a.discoveryContext('Genoa','Como'); assert.equal(context.source,'sahadan');
    assert.ok(!JSON.stringify(context).includes('ignoredLargeBody')); assert.ok(!JSON.stringify(context).includes('secret'));
});
test('context cache is bounded, source/squad scoped, and expires without extending source age', async t => {
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); let now=1000000;
    const cache=new DiscoveryContextCache({clock:()=>now}); const q={home:'Genoa',away:'Como'};
    const saved=cache.remember('sahadan',q,[row()],[]); assert.ok(saved);
    assert.equal(cache.get('mackolik',q,saved),null); assert.equal(cache.get('sahadan',{...q,home:'Genoa (K)'},saved),null);
    for(let i=0;i<101;i++) cache.remember('sahadan',{home:`Home${i}`,away:'Como'},[{...row('match'+i),team_A:{uuid:'home'+i,name:`Home${i}`}}],[]);
    assert.equal(cache.size,100); now+=300001; assert.equal(cache.get('sahadan',{home:'Home100',away:'Como'}),null);
});
test('source invalidation and original source expiry invalidate derived contexts', async t => {
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); t.mock.timers.enable({apis:['setTimeout','Date'],now:1000000}); fixture(t);
    const cache=new DiscoveryContextCache(); const q={home:'Genoa',away:'Como'}; const url='https://www.sahadan.com/takim/genoa/contextage';
    t.mock.method(globalThis,'fetch',async()=>new Response('source'));
    await http.sourceText(url,{ttl:100,source:'sahadan'}); t.mock.timers.tick(90);
    const read=await http.withSourceDependencies(()=>http.sourceText(url,{ttl:100,source:'sahadan'}));
    cache.remember('sahadan',q,[row()],read.dependencies); assert.ok(cache.get('sahadan',q));
    t.mock.timers.tick(11); assert.equal(cache.get('sahadan',q),null);
    const next=await http.withSourceDependencies(()=>http.sourceText(url,{ttl:100,source:'sahadan'}));
    cache.remember('sahadan',q,[row()],next.dependencies); http.invalidateSourceCache(url); assert.equal(cache.get('sahadan',q),null);
});
test('invalidation while discovery is loading prevents late context publication', async t => {
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); fixture(t); const cache=new DiscoveryContextCache();
    const q={home:'Genoa',away:'Como'}; const url='https://www.sahadan.com/takim/genoa/inflightteam'; let ready,release;
    const started=new Promise(r=>{ready=r;}); const gate=new Promise(r=>{release=r;});
    t.mock.method(globalThis,'fetch',async()=>{ready();await gate;return new Response('loaded');});
    const result=cache.read('sahadan',q,async()=>{await http.sourceText(url,{source:'sahadan'});return [row()];});
    await started; http.invalidateSourceCache(url); release(); await result; assert.equal(cache.get('sahadan',q),null);
});
test('cache first created inside a caller scope keeps a surviving subscriber independent', async () => {
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); let cache,ready,release,signal; const first=new AbortController();
    const q={home:'Genoa',away:'Como'}; const started=new Promise(r=>{ready=r;}); const gate=new Promise(r=>{release=r;});
    const loader=async()=>{signal=http.getSourceDeadlineSignal();ready();await gate;return [row()];};
    const a=http.withSourceDeadline(()=>{cache=new DiscoveryContextCache();return cache.read('sahadan',q,loader);},{signal:first.signal});
    const firstResult=Promise.allSettled([a]); await started; const b=cache.read('sahadan',q,loader);
    first.abort(new DOMException('first cancelled','AbortError')); await firstResult; assert.equal(signal.aborted,false); release();
    assert.equal((await b).candidates[0].uuid,'contextmatch');
});
test('errors and invalid candidate payloads never become successful reusable contexts', async () => {
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); const cache=new DiscoveryContextCache(); const q={home:'Genoa',away:'Como'};
    await assert.rejects(cache.read('sahadan',q,async()=>{throw new http.SourceError('provider unavailable',502);}),/unavailable/);
    assert.equal(cache.get('sahadan',q),null);
    await cache.read('sahadan',q,async()=>[{...row(),uuid:'bad/id'}]); assert.equal(cache.get('sahadan',q),null);
    const good=cache.remember('sahadan',q,[row()],[]); const other=new DiscoveryContextCache();
    assert.equal(other.get('sahadan',q,{...good}),null);
});
test('abandoned loaders keep capacity until actual settlement and cannot publish late contexts', async () => {
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); const cache=new DiscoveryContextCache({limit:1}); const q={home:'Genoa',away:'Como'};
    let ready,release; const started=new Promise(r=>{ready=r;}); const gate=new Promise(r=>{release=r;}); const control=new AbortController();
    const request=cache.read('sahadan',q,async()=>{ready();await gate;return [row('abandoned')];},{signal:control.signal});
    const rejected=assert.rejects(request,error=>error.name==='AbortError'); await started;
    control.abort(new DOMException('all consumers gone','AbortError')); await rejected; await turn();
    try { await assert.rejects(cache.read('sahadan',q,async()=>[row('replacement')]),error=>error.errorCode==='DISCOVERY_QUEUE_FULL'); }
    finally { release(); await turn(); }
    assert.equal(cache.get('sahadan',q),null);
    const fresh=await cache.read('sahadan',q,async()=>[row('replacement')]); assert.equal(fresh.candidates[0].uuid,'replacement');
});
test('different stores and standalone scrapers cannot reuse another cache identity', async t => {
    const one=fixture(t); const two=new ReliabilityStore(); t.after(()=>two.close()); let searches=0;
    const scrapers=[new SahadanScraper({store:one}),new SahadanScraper({store:two}),new SahadanScraper(),new SahadanScraper()];
    for(const scraper of scrapers) scraper.api=async()=>{searches++;return{data:[{type:1,uuid:'genoateam',name:'Genoa'}]};};
    t.mock.method(globalThis,'fetch',async()=>new Response(html(row())));
    for(const scraper of scrapers) await scraper.pairCandidates('Genoa','Como');
    assert.equal(searches,4);
});
test('oversized discovery candidate sets remain complete but are not retained', async () => {
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); const cache=new DiscoveryContextCache(); const q={home:'Genoa',away:'Como'};
    const values=Array.from({length:65},(_,i)=>row('large'+i)); const result=await cache.read('sahadan',q,async()=>values);
    assert.equal(result.candidates.length,65); assert.equal(result.context,null); assert.equal(cache.size,0);
});
test('reference fields reject nested provider payloads instead of retaining raw objects', async () => {
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); const cache=new DiscoveryContextCache();
    assert.equal(cache.remember('sahadan',{home:'Genoa',away:'Como'},[{...row(),extras:{iddaa_code:{rawPayload:['must not survive']}}}]),null);
});
test('normalized reference storage has a per-context byte budget without clipping candidates', async () => {
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); const cache=new DiscoveryContextCache(); const q={home:'Genoa',away:'Como'};
    const values=Array.from({length:40},(_,i)=>({...row('largeurl'+i),slug:'g'.repeat(1700)}));
    const result=await cache.read('sahadan',q,async()=>values); assert.equal(result.candidates.length,40); assert.equal(result.context,null);
});
test('valid empty discovery stays distinct from a failed or malformed source response', async () => {
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); const cache=new DiscoveryContextCache(); const q={home:'Genoa',away:'Como'};
    const empty=await cache.read('sahadan',q,async()=>[]); assert.deepEqual(empty.candidates,[]); assert.equal(empty.context,null);
    const failure=new http.SourceError('upstream missing',502);
    await assert.rejects(cache.read('sahadan',q,async()=>{throw failure;}),error=>error===failure);
    await assert.rejects(cache.read('sahadan',q,async()=>({matches:[]})),/veri yapısı/);
    assert.equal(cache.get('sahadan',q),null);
});
test('two lookup consumers retain a complete trace graph through shared discovery and public GET', async t => {
    fixture(t); const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); const cache=new DiscoveryContextCache();
    const before=process.env.NODE_ENV;process.env.NODE_ENV='production';t.after(()=>{if(before===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=before;});
    const logs=[];t.mock.method(console,'info',value=>logs.push(JSON.parse(value)));let ready,release;
    const started=new Promise(r=>{ready=r;});const gate=new Promise(r=>{release=r;});
    t.mock.method(globalThis,'fetch',async()=>{ready();await gate;return new Response('source');});
    const query={home:'Genoa',away:'Como'};const load=async()=>{await http.sourceText('https://www.sahadan.com/takim/private-team/contexttrace?secret=private-query',{source:'sahadan',sharedRead:true});return[row()];};
    const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
    const pending=ids.map(id=>http.withRequestTrace(()=>http.withLookupTrace(id,()=>cache.read('sahadan',query,load))));
    await started;release();await Promise.all(pending);
    const joins=logs.filter(e=>e.event==='discovery-read-join');const reads=logs.filter(e=>e.event==='source-read-join');const attempts=logs.filter(e=>e.event==='source-request');
    assert.deepEqual(joins.map(e=>e.lookupId).sort(),ids);assert.ok(joins.every(e=>e.requestId&&e.discoveryId===joins[0].discoveryId));
    assert.equal(attempts.length,1);assert.ok(reads.some(e=>e.parentTransportId===joins[0].discoveryId&&e.transportId===attempts[0].transportId));
    assert.ok(!JSON.stringify(logs).includes('private-'));
});
test('all cancelled discovery subscribers log cancellation rather than a successful upstream status', async t => {
    fixture(t);const {DiscoveryContextCache}=await import('../src/discoveryContext.js');const cache=new DiscoveryContextCache();
    const before=process.env.NODE_ENV;process.env.NODE_ENV='production';t.after(()=>{if(before===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=before;});
    const logs=[];t.mock.method(console,'info',value=>logs.push(JSON.parse(value)));let ready;
    const started=new Promise(r=>{ready=r;});t.mock.method(globalThis,'fetch',async(_url,{signal})=>{ready();return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
    const controls=[new AbortController(),new AbortController()];const load=async()=>{await http.sourceText('https://www.sahadan.com/takim/genoa/contextcancel',{source:'sahadan',sharedRead:true});return[row()];};
    const requests=controls.map(c=>cache.read('sahadan',{home:'Genoa',away:'Como'},load,{signal:c.signal}));const settled=Promise.allSettled(requests);
    await started;controls.forEach(c=>c.abort(new DOMException('all cancelled','AbortError')));await settled;await turn();
    const attempts=logs.filter(e=>e.event==='source-request');assert.equal(attempts.length,1);assert.equal(attempts[0].status,499);assert.equal(attempts[0].outcome,'cancelled');
    assert.equal(cache.get('sahadan',{home:'Genoa',away:'Como'}),null);
});
for (const [label,authority] of [['username','fixture-user@www.mackolik.com'],['password','fixture-user:fixture-password@www.mackolik.com'],['port','www.mackolik.com:8443']]) {
    test(`source references reject URL ${label} at the context boundary`, async () => {
        const {DiscoveryContextCache}=await import('../src/discoveryContext.js');const cache=new DiscoveryContextCache();
        const value={matchId:'urlauth',homeTeamId:'genoateam',awayTeamId:'comoteam',homeTeamName:'Genoa',awayTeamName:'Como',matchDate:'2026-10-29',score:'0 - 2',url:`https://${authority}/mac/genoa-vs-como/iddaa/urlauth`};
        assert.equal(cache.remember('mackolik',{home:'Genoa',away:'Como'},[value]),null);assert.equal(cache.size,0);
    });
}

test('independent budget expiry cannot publish a late ignored-abort loader', async t => {
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js');
    t.mock.timers.enable({apis:['setTimeout','Date'],now:1000000});
    const cache=new DiscoveryContextCache({limit:1}); const q={home:'Genoa',away:'Como'};
    let ready,release; const started=new Promise(r=>{ready=r;}); const gate=new Promise(r=>{release=r;});
    const request=cache.read('sahadan',q,async()=>{ready();await gate;return [row('latebudget')];});
    const rejected=assert.rejects(request,error=>error.status===504); await started;
    t.mock.timers.tick(120001); await rejected;
    try { await assert.rejects(cache.read('sahadan',q,async()=>[row('replacement')]),error=>error.errorCode==='DISCOVERY_QUEUE_FULL'); }
    finally { release(); await turn(); }
    assert.equal(cache.get('sahadan',q),null);
    const fresh=await cache.read('sahadan',q,async()=>[row('replacement')]); assert.equal(fresh.candidates[0].uuid,'replacement');
});

for (const slug of ['foo/bar','foo/../bar','foo\\bar']) test(`Sahadan context declines lossy source slug ${slug}`,async()=>{
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); const cache=new DiscoveryContextCache();
    assert.equal(cache.remember('sahadan',{home:'Genoa',away:'Como'},[{...row(),slug}]),null);
});
for (const path of ['/mac/urlauth/iddaa/other','/mac/genoa/urlauth/iddaa','/mac/genoa/extra/iddaa/urlauth']) test(`Mackolik context requires the exact source ID placement ${path}`,async()=>{
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); const cache=new DiscoveryContextCache();
    const value={matchId:'urlauth',homeTeamId:'genoateam',awayTeamId:'comoteam',homeTeamName:'Genoa',awayTeamName:'Como',matchDate:'2026-10-29',score:'0 - 2',url:`https://www.mackolik.com${path}`};
    assert.equal(cache.remember('mackolik',{home:'Genoa',away:'Como'},[value]),null);
});
for (const slug of ['genoa%20vs%20como','genoa%2Fcomo','gênóa-vs-como','genoa vs como']) test(`Sahadan context preserves its original source URL for ${slug}`,async()=>{
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); const {normalizeSahadanMatch}=await import('../src/sahadanParser.js');
    const cache=new DiscoveryContextCache(); const q={home:'Genoa',away:'Como'}; const value={...row(),slug};
    const context=cache.remember('sahadan',q,[value]); assert.ok(context);
    assert.equal(normalizeSahadanMatch(cache.candidates(context,'sahadan',q)[0]).sourceUrl,normalizeSahadanMatch(value).sourceUrl);
});

test('projection crossing the caller deadline cannot publish context evidence',async t=>{
    const {DiscoveryContextCache}=await import('../src/discoveryContext.js'); t.mock.timers.enable({apis:['setTimeout','Date'],now:1000000});
    const cache=new DiscoveryContextCache(); const q={home:'Genoa',away:'Como'}; let advanced=false;
    const value={matchId:'cpuclock',homeTeamId:'genoateam',awayTeamId:'comoteam',get homeTeamName(){if(!advanced){advanced=true;t.mock.timers.tick(51);}return 'Genoa';},awayTeamName:'Como',matchDate:'2026-10-29',score:'0 - 2',url:'https://www.mackolik.com/mac/genoa-vs-como/iddaa/cpuclock'};
    await assert.rejects(http.withSourceDeadline(()=>cache.remember('mackolik',q,[value]),{timeoutMs:50}),error=>error.status===504);
    assert.equal(cache.get('mackolik',q),null);
});
