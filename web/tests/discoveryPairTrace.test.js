import assert from 'node:assert/strict';
import test from 'node:test';
import { PairVariantResolver } from '../src/pairVariantResolver.js';
import { SahadanScraper } from '../src/SahadanScraper.js';
import { ReliabilityStore, configureReliabilityStore } from '../src/reliabilityStore.js';
import * as http from '../src/sourceHttp.js';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
const query={home:'Genoa',away:'Como'};
function setup(t,suffix) {
    const store=new ReliabilityStore(); configureReliabilityStore(store);
    const before=process.env.NODE_ENV; process.env.NODE_ENV='production';
    t.after(()=>{configureReliabilityStore(null);store.close();if(before===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=before;});
    const logs=[]; t.mock.method(console,'info',value=>logs.push(JSON.parse(value)));
    const sahadan=new SahadanScraper({store});
    sahadan.api=async()=>({data:[{type:1,uuid:'tracehome'+suffix,name:'Genoa'}]});
    const raw={uuid:'tracematch'+suffix,slug:'genoa-vs-como',team_A:{uuid:'tracehome'+suffix,name:'Genoa'},team_B:{uuid:'traceaway'+suffix,name:'Como'},date_time_utc:'2026-10-29 19:45:00',status:'Played',fts_A:0,fts_B:2,extras:{iddaa_code:123}};
    const table=[]; const add=value=>{const index=table.length;table.push(null);table[index]=value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,v])=>[key,add(v)])):value;return index;};
    add({data:{schedule:{match:raw}}}); const body=`<script id="__NUXT_DATA__">${JSON.stringify(table)}</script>`;
    return {logs,sahadan,body,resolver:new PairVariantResolver({sahadan,verifyPrimary:async()=>false})};
}
function traceGraph(logs) {
    const joins=logs.filter(e=>e.event==='pair-resolution-join'); assert.equal(joins.length,2);
    assert.deepEqual(joins.map(e=>e.lookupId).sort(),ids); assert.ok(joins.every(e=>e.requestId));
    assert.equal(joins[0].pairResolutionId,joins[1].pairResolutionId);
    assert.match(joins[0].pairResolutionId,/^[a-f0-9-]{36}$/);
    const discovery=logs.filter(e=>e.event==='discovery-read-join'); assert.equal(discovery.length,1);
    assert.equal(discovery[0].parentTransportId,joins[0].pairResolutionId);
    const reads=logs.filter(e=>e.event==='source-read-join'); const attempts=logs.filter(e=>e.event==='source-request');
    assert.equal(attempts.length,1);
    assert.ok(reads.some(e=>e.parentTransportId===discovery[0].discoveryId&&e.transportId===attempts[0].transportId));
    assert.ok(!/Genoa|Como|takim|__NUXT_DATA__|tracehome/.test(JSON.stringify(logs)));
}
const call=(resolver,id,options)=>http.withRequestTrace(()=>http.withLookupTrace(id,()=>resolver.resolve(query,options)));

test('real pair resolver traces both caller roots through neutral discovery and its shared GET',async t=>{
    const {logs,resolver,body}=setup(t,'complete'); let ready,release;
    const started=new Promise(r=>{ready=r;});const gate=new Promise(r=>{release=r;});
    t.mock.method(globalThis,'fetch',async()=>{ready();await gate;return new Response(body);});
    const requests=ids.map(id=>call(resolver,id));await started;release();
    assert.ok((await Promise.all(requests)).every(value=>value.status==='main')); traceGraph(logs);
    const count=logs.length;assert.equal((await call(resolver,ids[0])).status,'main');assert.equal(logs.length,count);
    const c=new AbortController();c.abort(new DOMException('already cancelled','AbortError'));
    await assert.rejects(call(resolver,ids[0],{signal:c.signal}),error=>error.name==='AbortError');
    assert.equal((await resolver.resolve({...query,date:'2026-10-29'})).status,'preserve');assert.equal(logs.length,count);
});

for(const all of [false,true]) test(`pair trace joining preserves ${all?'all':'one'} caller cancellation`,async t=>{
    const {logs,resolver,sahadan,body}=setup(t,all?'allcancel':'survivor'); let ready,release,fetchSignal;
    const started=new Promise(r=>{ready=r;});const gate=new Promise(r=>{release=r;});
    t.mock.method(globalThis,'fetch',async(_url,{signal})=>{fetchSignal=signal;ready();if(all)return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));await gate;return new Response(body);});
    const controls=[new AbortController(),new AbortController()];const requests=ids.map((id,i)=>call(resolver,id,{signal:controls[i].signal}));
    const settled=Promise.allSettled(requests);await started;controls[0].abort(new DOMException('first cancelled','AbortError'));
    await assert.rejects(requests[0],error=>error.name==='AbortError');
    if(all){controls[1].abort(new DOMException('second cancelled','AbortError'));await settled;await turn();assert.equal(fetchSignal.aborted,true);assert.equal(sahadan.discoveryContext(query.home,query.away),null);}
    else{assert.equal(fetchSignal.aborted,false);release();assert.equal((await requests[1]).status,'main');await settled;}
    traceGraph(logs);
    if(all){const attempt=logs.find(e=>e.event==='source-request');assert.equal(attempt.status,499);assert.equal(attempt.outcome,'cancelled');}
});
