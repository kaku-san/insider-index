import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { linkedToken, isSolanaAddress, shortMint } from '../src/lib/frontend/linked-token.ts';
import { allocationView } from '../src/lib/frontend/allocation-view.ts';
import { INDEX_CONTENT } from '../src/lib/frontend/index-content.ts';
import { derivePersonIndex } from '../src/lib/index-vaults/person-index-map.ts';
import { enrichPublicVaultLegSymbols, readPublicVaultDefinition, type PublicVaultLeg } from '../src/lib/index-vaults/vault-definition-store.ts';
import { indexCatalog } from '../src/lib/venues/catalog-parse.ts';
import { snapshotCatalog } from '../src/lib/venues/solana-catalog.ts';
import { PENDING_POOL_SOURCE } from '../src/lib/index-vaults/pool-evidence.ts';
register('./support/ui-loader.mjs', import.meta.url);
const { PersonIndexProof, personIndexAllocation } = await import('../src/components/consumer-index.tsx');
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
 const index={hash:'hash',person_id:'person',constituents:[{ticker:'AAPL',symbol:'AAPLx',mint,issuer:'xstock',weight_bps:10000}],definition:{excluded:[{holdingId:'fund',ticker:'FUND',name:'Unmapped mutual fund',reason:'no-token'}]}};
 const rows=personIndexAllocation(index,[{ticker:'FUND',name:'Unmapped mutual fund'},{ticker:'BOND',name:'Source-only bond'}],'mainnet-beta');
 assert.equal(rows.length,3);
 assert.equal(rows[0].tokenSymbol,'AAPLx');
 assert.equal(rows[0].mint,mint);
 assert.ok(Number.isNaN(rows[1].weightBps));
 assert.equal(rows[1].mint,null);
 assert.equal(rows[2].ticker,'BOND');
 const proof=renderToStaticMarkup(createElement(PersonIndexProof,{items:rows,coverageBps:10000,updated:'Sep 23, 2026'}));
 assert.match(proof,/3 holdings/);
 assert.match(proof,/Sep 23, 2026/);
});
test('public vault legs enrich symbols by exact catalog mint only',()=>{
 const knownMint='A'.repeat(44);
 const unknownMint='B'.repeat(44);
 const exactMintCatalog=indexCatalog([{ticker:'AAPL',mint:knownMint,issuer:'xstock',symbol:'AAPLx',name:'Apple',decimals:8}]);
 const leg=(ticker:string,mint:string):PublicVaultLeg=>({ticker,mint,provider:'xstock',bookWeightBps:5000,targetWeightBps:5000,vaultReady:true});
 const rows=enrichPublicVaultLegSymbols([leg('NOT-AAPL',knownMint),leg('AAPL',unknownMint)],exactMintCatalog);
 assert.equal(rows[0].symbol,'AAPLx');
 assert.equal(rows[1].symbol,undefined);
});
test('public definition reads enrich from the local catalog without a network request',async()=>{
 const token=snapshotCatalog().tokens[0];
 const unknownMint='B'.repeat(44);
 const row={index_id:'insiderindex-test',kind:'person',person_slug:'test',bioguide_id:'T000001',name:'Test Index',symbol:'IITEST',status:'CREATABLE',network:'mainnet-beta',weight_basis:'annual',deposits_enabled:false,deposit_reason:'closed',coverage:{},provenance:{kind:'person'},legs:[{ticker:'NOT-'+token.ticker,mint:token.mint,provider:token.issuer,bookWeightBps:5000,targetWeightBps:5000,vaultReady:true},{ticker:token.ticker,mint:unknownMint,provider:token.issuer,bookWeightBps:5000,targetWeightBps:5000,vaultReady:true}],unmapped:[],vault_address:null,share_mint:null,updated_at:'2026-09-23T00:00:00Z'};
 const db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:row,error:null})})})})};
 const originalFetch=globalThis.fetch;
 let fetches=0;
 globalThis.fetch=(async()=>{fetches++;throw new Error('network disabled')}) as typeof fetch;
 try{
  const result=await readPublicVaultDefinition(db as never,row.index_id);
  assert.equal(fetches,0);
  assert.equal(result?.legs[0].symbol,token.symbol);
  assert.equal(result?.legs[1].symbol,undefined);
 }finally{globalThis.fetch=originalFetch;}
});
