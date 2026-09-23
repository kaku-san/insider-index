import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { INDEX_CONTENT, indexContentFor, indexProofFor } from '../src/lib/frontend/index-content.ts';
import { THEME_ART } from '../src/lib/frontend/theme-art.ts';
import { allocationView } from '../src/lib/frontend/allocation-view.ts';
import { companyNameFor } from '../src/lib/frontend/company-logos.ts';
const root = new URL('../', import.meta.url);
const text=(p:string)=>readFileSync(new URL(p,root),'utf8');

test('all 20 indexes retain consumer copy',()=>{assert.equal(Object.keys(INDEX_CONTENT).length,20);assert.equal(indexContentFor('missing'),null);});
test('all 10 themes have distinct local cover + thumbnail assets',()=>{
 assert.equal(Object.keys(THEME_ART).length,10);assert.equal(new Set(Object.values(THEME_ART).map(x=>x.src)).size,10);
 for(const item of Object.values(THEME_ART)){assert.ok(existsSync(new URL('public'+item.src,root)));assert.ok(existsSync(new URL('public'+item.thumb,root)));assert.ok(item.alt.length>20);}
});
test('Mag7 proof follows the current source constituents, not a hard-coded eight',()=>{
 const data=JSON.parse(text('src/lib/thematic/thematic-indexes.live.json'));
 const mag7=data.website.find((x:{id:string})=>x.id==='idx-theme-mag7-caucus');
 assert.equal(mag7.constituents.length,7);
 assert.match(indexProofFor({holdingCount:mag7.constituents.length}),/^7 holdings$/);
 assert.doesNotMatch(JSON.stringify(INDEX_CONTENT['idx-theme-mag7-caucus']),/\b(?:8|eight)\b/i);
});
test('singular, zero and changed counts render without stale marketing numbers',()=>{
 assert.equal(indexProofFor({holdingCount:1}),'1 holding');
 assert.equal(indexProofFor({holdingCount:0}),'0 holdings');
 assert.equal(indexProofFor({holdingCount:18,memberCount:4}),'18 holdings · 4 source filers');
});
test('only an explicitly supplied valid coverage value is rendered',()=>{
 assert.equal(indexProofFor({holdingCount:7,coverageBps:null}),'7 holdings');
 assert.equal(indexProofFor({holdingCount:7,coverageBps:10001}),'7 holdings');
 assert.equal(indexProofFor({holdingCount:7,coverageBps:9690}),'7 holdings · 96.9% of disclosed weight mapped');
});
test('source counts are not embedded in any marketing proof',()=>{for(const content of Object.values(INDEX_CONTENT))assert.doesNotMatch(content.heroProof,/\d/);});
test('allocation keeps every supplied basis point, including the Other aggregate',()=>{
 const result=allocationView(Array.from({length:10},(_,i)=>({ticker:`C${i}`,weightBps:1000})));
 assert.equal(result.rows.reduce((n,x)=>n+x.weightBps,0),10000);assert.equal(result.rows.at(-1)?.otherCount,4);assert.equal(result.rows.at(-1)?.weightBps,4000);
});
test('partial source coverage is not silently rescaled to a full portfolio',()=>{
 const result=allocationView([{ticker:'A',weightBps:3000},{ticker:'B',weightBps:2000}]);
 assert.equal(result.totalBps,5000);assert.equal(result.rows[0].weightBps,3000);assert.equal(result.rows.at(-1)?.weightBps,5000);assert.equal(result.rows.at(-1)?.missing,true);
});
test('overweight source is retained and identified, not rewritten',()=>{
 const result=allocationView([{ticker:'A',weightBps:8000},{ticker:'B',weightBps:4000}]);
 assert.equal(result.totalBps,12000);assert.equal(result.denominator,12000);assert.equal(result.rows[0].weightBps,8000);
});
test('invalid and zero weights do not create made-up slices',()=>{
 const result=allocationView([{ticker:'A',weightBps:NaN},{ticker:'B',weightBps:-1},{ticker:'C',weightBps:0}]);assert.equal(result.count,0);assert.equal(result.rows.length,0);
});
test('concentration is calculated from real weights',()=>{
 const result=allocationView([{ticker:'A',weightBps:4000},{ticker:'B',weightBps:3000},{ticker:'C',weightBps:2000},{ticker:'D',weightBps:1000}]);assert.equal(result.topThreeBps,9000);
});
test('company labels no longer expose CRM as xstock',()=>{
 assert.equal(companyNameFor('CRM','xstock'),'Salesforce');assert.equal(companyNameFor('ZZZZ','xstock'),'ZZZZ');assert.equal(companyNameFor('ZZZZ','Example Company xStock'),'Example Company');
});
test('homepage has one table and one ecosystem strip, no screenshot hero or repeated theme collage',()=>{
 const source=text('src/components/consumer-home.tsx');assert.doesNotMatch(source,/home-hero|heroArtwork|themeCallout|themes-banner|const infra =/);assert.equal((source.match(/<EcosystemLogos\s*\//g)||[]).length,1);assert.match(source,/themeArtFor\(id\)\?\.thumb/);
});
test('both index pages use exactly one allocation view and no second top-holdings panel',()=>{
 for(const p of ['src/components/consumer-index.tsx','src/components/thematic-index.tsx']){const s=text(p);assert.equal((s.match(/<IndexAllocation\b/g)||[]).length,1);assert.doesNotMatch(s,/<TopHoldings|<Allocation\s|function TopHoldings|What.s inside|Where the weight sits|these seven/i);}
});
test('the public person profile has one Allocation surface without duplicate headings',()=>{
 const s=text('src/components/profile-view.tsx');const part=s.slice(s.indexOf('{tab==="allocation"?'),s.indexOf('{tab==="moves"?'));assert.equal((part.match(/<IndexAllocation\b/g)||[]).length,1);assert.doesNotMatch(part,/Recent moves|Top holdings|AllocationBreakdown/);
});
test('seven brand marks are bundled; FMP is explicitly a typographic wordmark, not an invented icon',()=>{
 const sources=JSON.parse(text('public/brand/integrations/SOURCES.json'));
 for(const id of ['solana','jupiter','raydium','privy','backpack','symmetry','xstocks'])assert.match(text(`public/brand/integrations/${id}.svg`),/<path/);
 assert.equal(sources.assets.length,8);assert.match(sources.assets.find((x:{id:string})=>x.id==='fmp').kind,/typographic/);
});
