import assert from 'node:assert/strict';
import test from 'node:test';
import { SahadanScraper } from '../src/SahadanScraper.js';
import { MackolikScraper } from '../src/MackolikScraper.js';
import { DiscoveryContextCache } from '../src/discoveryContext.js';
const raw={uuid:'directcontext',slug:'genoa-vs-como',team_A:{uuid:'genoateam',name:'Genoa'},team_B:{uuid:'comoteam',name:'Como'},date_time_utc:'2026-10-29 19:45:00',status:'Played',fts_A:0,fts_B:2,extras:{iddaa_code:123}};
const rates={data:{sg_event_id:123,markets:[{n:'Maç Sonucu',o:[{b:14,l:[{i:'14_123-1',n:'1',v:2.1}]}]}],squad_links:{14:'https://www.nesine.com/'}}};
test('known same-source candidate uses only detail and rates without pair rediscovery',async()=>{
 const cache=new DiscoveryContextCache(); const context=cache.remember('sahadan',{home:'Genoa',away:'Como'},[raw]); const s=new SahadanScraper({discoveryCache:cache}); const calls=[];
 s.pairCandidates=()=>assert.fail('known identity must not rediscover'); s.api=async(path)=>{calls.push(path);return path==='match-detail'?{data:{match:raw}}:rates;};
 const result=await s.historical('Genoa','Como','2026-10-29',null,{discoveryContext:context});
 assert.deepEqual(calls,['match-detail','rates-match']); assert.equal(result.match.score,'0 - 2'); assert.equal(result.oddsProvider,'nesine');
});
test('Mackolik reopens its independently verified source reference instead of rediscovering',async t=>{
 let discoveries=0; const parsed={matchId:'mackcontext',homeTeam:'Genoa',awayTeam:'Como',homeTeamId:'genoateam',awayTeamId:'comoteam',matchDate:'29.10.2026',score:'0 - 2',sourceUrl:'https://www.mackolik.com/mac/genoa-vs-como/iddaa/mackcontext',providers:[]};
 const s=new MackolikScraper({debug:false,nativeDiscovery:{discover:async()=>{discoveries++;return{candidates:[{}],errors:[]};}}});
 s.getRecentDateCandidates=()=>[]; s.tryHttpCandidates=async()=>parsed;
 t.mock.method(globalThis,'fetch',async()=>new Response('<html><head><title>Genoa vs Como, İddaa Oranları & Sonuçları, 29.10.2026 | Mackolik.com</title><link rel="canonical" href="https://www.mackolik.com/mac/genoa-vs-como/mackcontext"></head><body><span class="p0c-soccer-match-details-header__score-home">0</span><span class="p0c-soccer-match-details-header__score-away">2</span></body></html>'));
 await s.scrapeHistoricalMatch('Genoa','Como'); const second=await s.scrapeHistoricalMatch('Genoa','Como');
 assert.equal(discoveries,1); assert.equal(second.matchId,'mackcontext'); assert.equal(second.score,'0 - 2');
});

for (const cancelled of [false,true]) test(`late Mackolik discovery cannot publish after ${cancelled?'cancellation':'deadline'}`,async t=>{
    const http=await import('../src/sourceHttp.js'); t.mock.timers.enable({apis:['setTimeout','Date'],now:1000000});
    const cache=new DiscoveryContextCache(); const s=new MackolikScraper({debug:false,discoveryCache:cache});
    const parsed={matchId:'macklate',homeTeam:'Genoa',awayTeam:'Como',homeTeamId:'genoateam',awayTeamId:'comoteam',matchDate:'29.10.2026',score:'0 - 2',sourceUrl:'https://www.mackolik.com/mac/genoa-vs-como/iddaa/macklate',providers:[]};
    let ready,release; const started=new Promise(r=>{ready=r;}); const gate=new Promise(r=>{release=r;}); const control=new AbortController();
    s.loadHistoricalMatch=async()=>{ready();await gate;return parsed;};
    const request=http.withSourceDeadline(()=>s.scrapeHistoricalMatch('Genoa','Como'),{timeoutMs:50,signal:control.signal});
    const rejected=assert.rejects(request,error=>cancelled?error.name==='AbortError':error.status===504); await started;
    if(cancelled) control.abort(new DOMException('caller cancelled','AbortError')); else t.mock.timers.tick(51);
    await rejected; release(); await new Promise(r=>setImmediate(r));
    assert.equal(cache.get('mackolik',{home:'Genoa',away:'Como'}),null);
});
