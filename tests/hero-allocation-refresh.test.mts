import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { linkedToken, isSolanaAddress, shortMint } from '../src/lib/frontend/linked-token.ts';
import { allocationView } from '../src/lib/frontend/allocation-view.ts';
import { INDEX_CONTENT } from '../src/lib/frontend/index-content.ts';
import { derivePersonIndex } from '../src/lib/index-vaults/person-index-map.ts';
import { indexCatalog } from '../src/lib/venues/catalog-parse.ts';
import { PENDING_POOL_SOURCE } from '../src/lib/index-vaults/pool-evidence.ts';
register('./support/ui-loader.mjs', import.meta.url);
const { personIndexAllocation } = await import('../src/components/consumer-index.tsx');
const text=(p:string)=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
// Derived from the committed catalog snapshot, FMP person books and thematic feed (not a preview snapshot).
const snapshot=JSON.parse(text('src/lib/venues/catalog-snapshot.json'));
const catalog=indexCatalog([...snapshot.xstocks,...snapshot.backpack]);
const people=Object.keys(INDEX_CONTENT).filter(id=>id.startsWith('insiderindex-')).map(id=>{
 const book=JSON.parse(text(`data/insiderindex-source-buckets/pelositracker-fmp-latest-top20/holdings/${id.replace('insiderindex-','')}.json`));
 return {id,holdings:derivePersonIndex(book,catalog,PENDING_POOL_SOURCE).legs.map(l=>({ticker:l.ticker,mint:l.mint}))};
});
type SourceIndex={id:string;holdings:{ticker:string;mint:string}[]};
const themes:SourceIndex[]=JSON.parse(text('src/lib/thematic/thematic-indexes.live.json')).website.map((x:{id:string;constituents:{ticker:string;mint:string}[]})=>({id:x.id,holdings:x.constituents.map(l=>({ticker:l.ticker,mint:l.mint}))}));
const data:{indexes:SourceIndex[]}={indexes:[...people,...themes]};
const mint=data.indexes.find(x=>x.id==='idx-theme-mag7-caucus')!.holdings[0].mint;
test('every source constituent has an exact usable source public-key shape',()=>{
 const holdings=data.indexes.flatMap(x=>x.holdings);
 assert.equal(data.indexes.length,20);assert.ok(holdings.length>300);
 for(const h of holdings){assert.ok(isSolanaAddress(h.mint),h.ticker);assert.equal(linkedToken(h).mint,h.mint);}
});
test('mint shape validation rejects malformed and injected addresses',()=>{
 for(const value of [null,undefined,'','abc','https://example.com','javascript:alert(1)',mint+' ', '0'.repeat(44), 'z'.repeat(44), '1'.repeat(31), '1'.repeat(33)])assert.equal(isSolanaAddress(value),false);
 assert.equal(isSolanaAddress('1'.repeat(32)),true);
});
test('mainnet explorer links contain the exact source mint',()=>{
 const result=linkedToken({mint,network:'mainnet-beta',issuer:'xstock'});
 assert.equal(result.mint,mint);assert.equal(result.solscan,'https://solscan.io/token/'+mint);assert.equal(result.issuer,'xStocks');
});
test('test networks never silently fall back to mainnet',()=>{
 for(const network of ['devnet','testnet']){const result=linkedToken({mint,network});assert.ok(result.solscan?.endsWith('?cluster='+network));assert.ok(result.explorer?.endsWith('?cluster='+network));}
});
test('unknown network preserves address but refuses misleading explorer links',()=>{
 for(const network of [null,undefined,'wrong-network']){const result=linkedToken({mint,network});assert.equal(result.mint,mint);assert.equal(result.solscan,null);assert.equal(result.explorer,null);}
});
test('missing address never gains a guessed ticker mapping',()=>{
 assert.equal(linkedToken({tokenSymbol:'AAPLx',network:'mainnet-beta'}).mint,null);
 assert.equal(linkedToken({mint:'incorrect',network:'mainnet-beta'}).explorer,null);
 assert.equal(shortMint(mint),mint.slice(0,6)+'…'+mint.slice(-6));
});
test('allocation transport retains addresses and preserves basis points',()=>{
 const rows=allocationView([{ticker:'ONE',weightBps:6000,mint,network:'mainnet-beta',issuer:'xstock'},{ticker:'TWO',weightBps:4000}]).rows;
 assert.equal(rows[0].mint,mint);assert.equal(rows[0].weightBps,6000);assert.equal(rows[1].weightBps,4000);
});
test('person index allocation keeps source-only rows and supplied token symbols',()=>{
 const index={hash:'hash',person_id:'person',constituents:[{ticker:'AAPL',mint,issuer:'xstock',weight_bps:10000}],definition:{evidence:[{token:{mint,issuer:'xstock',symbol:'AAPLx'}}],excluded:[{holdingId:'fund',ticker:'FUND',name:'Unmapped mutual fund',reason:'no-token'}]}};
 const rows=personIndexAllocation(index,[{ticker:'FUND',name:'Unmapped mutual fund'},{ticker:'BOND',name:'Source-only bond'}],'mainnet-beta');
 assert.equal(rows.length,3);
 assert.equal(rows[0].tokenSymbol,'AAPLx');
 assert.equal(rows[0].mint,mint);
 assert.ok(Number.isNaN(rows[1].weightBps));
 assert.equal(rows[1].mint,null);
 assert.equal(rows[2].ticker,'BOND');
});
