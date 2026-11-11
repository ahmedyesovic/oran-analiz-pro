import assert from 'node:assert/strict';
import test from 'node:test';
import { PairVariantResolver } from '../src/pairVariantResolver.js';
import { SourceError, getSourceDeadlineSignal } from '../src/sourceHttp.js';

const base = { home: 'Atletico Madrid', away: 'Badalona' };
const row = (hid='home1', aid='away1', id='match1') => ({
    uuid: id, date_time_utc: '2026-01-01 12:00:00', status: 'Played', fts_A: 2, fts_B: 1,
    team_A: { name: 'At. Madrid (K)', uuid: hid }, team_B: { name: 'Badalona (K)', uuid: aid }
});
const main = () => ({ ...row('mainhome','mainaway'), team_A:{name:'Atl. Madrid',uuid:'mainhome'}, team_B:{name:'Badalona',uuid:'mainaway'} });
const clock = () => Date.parse('2026-11-11T12:00:00Z');
const ids = option => [option?.teamIdentities?.home?.providers?.[0]?.providerId,option?.teamIdentities?.away?.providers?.[0]?.providerId];
function make({ mainResult=[], homes=['home1'], aways=['away1'], pairs={}, failure, detailFailure, now=clock, maxTeamCandidates }={}) {
    const calls=[];
    const sahadan={
        async api(_path,opts){ const names=opts.search.startsWith('Atletico')?homes:aways; return {data:names.map(uuid=>({type:1,uuid,name:opts.search}))}; },
        async pairCandidates(h,a,option){
            calls.push([h,a,option]);
            if (!h.endsWith('(K)')) { if(failure) throw failure; return mainResult; }
            const [hid,aid]=ids(option); const key=hid+':'+aid;
            if (pairs[key] instanceof Error) throw pairs[key];
            return pairs[key] || [];
        },
        async detail(id){if(detailFailure) throw detailFailure;const all=Object.values(pairs).flat().filter(x=>x && !(x instanceof Error));return {match:all.find(x=>x.uuid===id)};}
    };
    return {resolver:new PairVariantResolver({sahadan,verifyPrimary:async()=>false,clock:now,maxTeamCandidates}),calls,sahadan};
}

test('preserves explicit selected identity, match, date, code or squad', async () => {
    const {resolver,calls}=make();
    for (const x of [{homeTeamId:'team1'}, {awayTeamId:'team2'}, {matchId:'id'}, {date:'2026-01-01'}, {code:'123'}, {home:'Atletico Madrid (K)'}]) assert.equal((await resolver.resolve({...base,...x})).status,'preserve');
    assert.equal(calls.length,0);
});
test('keeps primary squad before searching alternatives', async () => {
    const {resolver,calls}=make({mainResult:[main()]});
    assert.equal((await resolver.resolve(base)).status,'main');
    assert.equal(calls.length,1);
});
test('checks every returned candidate pair and verifies detail before selecting alternate', async () => {
    const {resolver,calls}=make({aways:['away1','away2'],pairs:{'home1:away2':[row('home1','away2')]}});
    const result=await resolver.resolve(base);
    assert.deepEqual({status:result.status,home:result.home,away:result.away,sourceMatchId:result.sourceMatchId},{status:'alternate',home:'Atletico Madrid (K)',away:'Badalona (K)',sourceMatchId:'match1'});
    assert.equal(calls.length,3);
});
test('does not pick when two distinct identity pairs have matches', async () => {
    const {resolver}=make({aways:['away1','away2'],pairs:{'home1:away1':[row()], 'home1:away2':[row('home1','away2','match2')]}});
    assert.equal((await resolver.resolve(base)).status,'ambiguous');
});
test('failed primary or alternate scan is never treated as an empty match set', async () => {
    const failure=new SourceError('source unavailable',502);
    const one=make({failure}); await assert.rejects(one.resolver.resolve(base),/source unavailable/); assert.equal(one.calls.length,1);
    const two=make({aways:['away1','away2'],pairs:{'home1:away1':[row()], 'home1:away2':failure}});
    await assert.rejects(two.resolver.resolve(base),/source unavailable/);
    const three=make({pairs:{'home1:away1':[row()]},detailFailure:failure});
    await assert.rejects(three.resolver.resolve(base),/source unavailable/);
});
test('team candidate bound does not choose from a truncated set', async () => {
    const {resolver}=make({homes:['home1','home2','home3'],maxTeamCandidates:2});
    assert.equal((await resolver.resolve(base)).status,'ambiguous');
});
test('invalid or inconsistent squad and IDs do not become successful candidates', async () => {
    const bad=row();bad.team_B.name='Badalona';
    const {resolver}=make({pairs:{'home1:away1':[bad]}});
    await assert.rejects(resolver.resolve(base),/doğrulanamadı/i);
});
test('concurrent requests share discovery and one cancellation cannot cancel the other', async () => {
    let release;let count=0;
    const {resolver}=make(); resolver.sahadan.pairCandidates=()=>{count++;return new Promise(r=>{release=r;});};
    const c=new AbortController();const a=resolver.resolve(base,{signal:c.signal});const b=resolver.resolve(base);
    while(!release) await new Promise(r=>setImmediate(r));
    c.abort(new Error('cancelled')); await assert.rejects(a,/cancelled/); release([main()]);
    assert.equal((await b).status,'main');assert.equal(count,1);
});
test('cancellation of all consumers cancels shared work and never caches a late response', async () => {
    let release;let count=0;
    const {resolver}=make();resolver.sahadan.pairCandidates=()=>{count++;return count===1?new Promise(r=>{release=r;}):Promise.resolve([main()]);};
    const c=new AbortController();const p=resolver.resolve(base,{signal:c.signal});
    while(!release) await new Promise(r=>setImmediate(r));
    c.abort(new Error('cancelled'));await assert.rejects(p,/cancelled/);release([main()]);
    await new Promise(r=>setImmediate(r));assert.equal((await resolver.resolve(base)).status,'main');assert.equal(count,2);
});
test('successful resolutions expire after short bounded cache lifetime', async () => {
    let now=clock(),count=0;const {resolver}=make({now:()=>now});
    resolver.sahadan.pairCandidates=async()=>{count++;return [main()];};
    await resolver.resolve(base);await resolver.resolve(base);assert.equal(count,1);
    now+=30001;await resolver.resolve(base);assert.equal(count,2);
});

test('current main Nesine bulletin wins without Sahadan discovery', async () => {
    const {resolver,calls}=make(); resolver.verifyPrimary=async()=>({match:{name:'current'}});
    assert.equal((await resolver.resolve(base)).status,'main');assert.equal(calls.length,0);
});
test('Nesine bulletin failure never becomes an alternate selection', async () => {
    const {resolver,calls}=make();resolver.verifyPrimary=async()=>{throw new SourceError('nesine timeout',504);};
    await assert.rejects(resolver.resolve(base),/nesine timeout/);assert.equal(calls.length,0);
});
test('shared discovery cannot run past its configured deadline', async () => {
    const {resolver}=make();resolver.timeoutMs=40;
    resolver.sahadan.pairCandidates=async()=>new Promise(()=>{});
    await assert.rejects(resolver.resolve(base),e=>e.status===504);
});

test('generic ambiguous names bypass variant discovery without provider requests', async () => {
    const {resolver,calls}=make();
    for (const home of ['City','United','Atletico']) {
        assert.equal((await resolver.resolve({...base,home})).status,'preserve');
    }
    assert.equal(calls.length,0);
});
