import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { Keypair, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatReceiptAmount, positionFromRow, positionToRow, type TrackedPosition } from "../src/lib/position-contract.ts";
import { memo, memoClear } from "../src/lib/cache.ts";
import { snapshotCatalog } from "../src/lib/venues/solana-catalog.ts";
import { jupiterMode, mocksAllowed } from "../src/lib/runtime.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { POST: quote } = await import("../src/app/api/quote/route.ts");
const { POST: execute } = await import("../src/app/api/execute/route.ts");
const { GET: copies } = await import("../src/app/api/positions/copies/route.ts");
const { POST: basketQuote } = await import("../src/app/api/indexes/quote/route.ts");
const { POST: basketExecute } = await import("../src/app/api/indexes/execute/route.ts");
const { CopyReceiptRows } = await import("../src/components/copy-positions.tsx");
const { assertPositionStoreReady, listPositions } = await import("../src/lib/positions.ts");
const { verifyCopyOrder, transactionMessageHash } = await import("../src/lib/copy-orders.ts");
const post = (path: string, body: unknown) => new Request(`https://app.test/api/${path}`, { method: "POST", body: JSON.stringify(body) });

// Exercise the real migration with PostgreSQL semantics, and the real Supabase client
// against a test PostgREST transport backed by that database. No live trade or secrets.
test("W0 production quote → signed message → Jupiter fill → durable, wallet-scoped receipt", async t => {
  const previous = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); memoClear(); });
  Object.assign(process.env, { NODE_ENV: "production", STOCKLANA_ALLOW_MOCKS: "1", JUPITER_MODE: "stub", NEXT_PUBLIC_STOCKLANA_PREVIEW: "1", NEXT_PUBLIC_SUPABASE_URL: "https://receipts.example.test", SUPABASE_SERVICE_ROLE_KEY: "test-only-service-role" });
  assert.equal(jupiterMode(), "live");
  assert.equal(mocksAllowed(), false);
  const preview = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", "import { PREVIEW_MODE } from './src/lib/frontend/api.ts'; process.stdout.write(String(PREVIEW_MODE));"], { env: process.env, encoding: "utf8" });
  assert.equal(preview, "false");

  const db = new PGlite();
  t.after(() => db.close());
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  await db.exec(await readFile(new URL("../supabase/migrations/202609150001_copy_positions.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../supabase/migrations/202609150002_prune_copy_orders.sql", import.meta.url), "utf8"));
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query("select * from positions"), /permission denied/);
    await assert.rejects(db.query("insert into copy_orders(request_id) values ('forged')"), /permission denied/);
    await db.exec("reset role");
  }
  await db.exec("set role service_role");
  const catalog = snapshotCatalog(), token = catalog.tokens.find(p => p.issuer === "xstock")!;
  await memo("catalog:merged", { ttlMs: 600_000 }, async () => catalog);
  const signer = Keypair.generate(), wallet = signer.publicKey.toBase58();
  let counter = 0, executeCalls = 0, storageFails = false, receiptWriteFails = false, jupiterFails = false, omitAmounts = false;
  const transactions = new Map<string, VersionedTransaction>();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "api.jup.ag") {
      if (url.pathname.endsWith("/order")) {
        assert.equal(url.searchParams.get("taker"), wallet);
        assert.deepEqual(new Set([url.searchParams.get("inputMint"), url.searchParams.get("outputMint")]), new Set([token.mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]));
        const requestId = `test-order-${++counter}`;
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message());
        transactions.set(requestId, tx);
        return Response.json({ requestId, transaction: Buffer.from(tx.serialize()).toString("base64"), inAmount: url.searchParams.get("amount"), outAmount: "50000000", taker: wallet });
      }
      executeCalls++;
      return Response.json(jupiterFails ? { status: "Failed", error: "route expired" } : { status: "Success", signature: `test-signature-${counter}`, ...(omitAmounts ? {} : { inputAmountResult: "1000000", outputAmountResult: "50000000" }) });
    }
    assert.equal(url.host, "receipts.example.test", "unexpected network request");
    assert.equal(new Headers(init?.headers).get("apikey"), "test-only-service-role");
    if (url.pathname.endsWith("/rpc/prune_expired_copy_orders")) {
      const { rows } = await db.query("select prune_expired_copy_orders() as deleted_count");
      return Response.json(rows[0]?.deleted_count ?? 0);
    }
    const table = url.pathname.split("/").pop()!;
    assert.ok(["positions", "copy_orders"].includes(table));
    if (storageFails || (receiptWriteFails && table === "positions" && init?.method === "POST")) return Response.json({ message: "private DB failure" }, { status: 503 });
    if (init?.method === "POST") {
      const row = JSON.parse(String(init.body)), keys = Object.keys(row);
      assert.ok(keys.every(k => /^[a-z_]+$/.test(k)));
      await db.query(`insert into ${table} (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})${url.searchParams.has("on_conflict") ? " on conflict (request_id) do nothing" : ""}`, Object.values(row));
      return new Response(null, { status: 201 });
    }
    const filters = [...url.searchParams].filter(([key]) => ["wallet", "request_id"].includes(key));
    const where = filters.length ? ` where ${filters.map(([key], i) => `${key} = $${i + 1}`).join(" and ")}` : "";
    const { rows } = await db.query(`select * from ${table}${where}${table === "positions" ? " order by created_at desc" : ""}`, filters.map(([, value]) => value.replace(/^eq\./, "")));
    const singular = new Headers(init?.headers).get("accept")?.includes("vnd.pgrst.object");
    return Response.json(singular ? rows[0] ?? null : rows);
  });
  const quoteBody = { outputMint: token.mint, usdcAmount: 1, taker: wallet, disclosureId: "print-1" };
  const q = await quote(post("quote", quoteBody));
  assert.equal(q.status, 200);
  const { order } = await q.json();
  assert.equal(order.mode, "live");
  const tx = transactions.get(order.requestId)!;
  tx.sign([signer]);
  const signed = Buffer.from(tx.serialize()).toString("base64");
  const body = { requestId: order.requestId, wallet, signedTransaction: signed, ticker: "FORGED", outputMint: "forged", inAmount: "999", outAmount: "999" };
  assert.equal((await execute(post("execute", { ...body, wallet: Keypair.generate().publicKey.toBase58() }))).status, 400);
  const invalidTx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [] }).compileToV0Message());
  assert.notEqual(transactionMessageHash(Buffer.from(invalidTx.serialize()).toString("base64")), transactionMessageHash(signed));
  assert.equal((await execute(post("execute", { ...body, signedTransaction: Buffer.from(invalidTx.serialize()).toString("base64") }))).status, 400);
  assert.equal(executeCalls, 0);
  const result = await execute(post("execute", body));
  assert.equal(result.status, 200);
  const receipt = await result.json();
  assert.equal(receipt.persistence, "saved");
  assert.equal(receipt.position.ticker, token.ticker);
  assert.equal(receipt.position.inputAmountRaw, "1000000");
  assert.equal(receipt.position.disclosureId, "print-1");
  assert.equal(receipt.position.stub, false);
  assert.deepEqual(positionFromRow(positionToRow(receipt.position)), receipt.position);
  assert.equal((await execute(post("execute", body))).status, 200);
  assert.equal((await db.query("select * from positions")).rows.length, 1, "idempotent persisted receipt");

  memoClear(); // A cold application cache still reads Supabase, not an in-memory receipt.
  const history = await copies(new Request(`https://app.test/api/positions/copies?wallet=${wallet}`));
  assert.equal(history.status, 200);
  assert.equal(history.headers.get("Cache-Control"), "no-store");
  const saved = await history.json();
  assert.equal(saved.positions[0].requestId, order.requestId);
  assert.equal(saved.valuation, null);
  assert.deepEqual(await listPositions(Keypair.generate().publicKey.toBase58()), []);
  assert.equal((await copies(new Request("https://app.test/api/positions/copies"))).status, 400);
  assert.equal((await copies(new Request(`https://app.test/api/positions/copies?wallet=${wallet}&wallet=${wallet}`))).status, 400);
  await memo("catalog:merged", { ttlMs: 600_000 }, async () => catalog);

  storageFails = true;
  const before = executeCalls;
  assert.equal((await execute(post("execute", body))).status, 503);
  assert.equal(executeCalls, before, "storage outage blocks submission");
  assert.equal((await copies(new Request(`https://app.test/api/positions/copies?wallet=${wallet}`))).status, 503);
  storageFails = false;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  await assert.rejects(assertPositionStoreReady(), /service role/);
  Object.assign(process.env, { SUPABASE_SERVICE_ROLE_KEY: "test-only-service-role" });

  await db.query("update copy_orders set expires_at=now()-interval '10 minutes' where request_id=$1", [order.requestId]);
  await db.query(
    "insert into copy_orders(request_id,wallet,disclosure_id,ticker,token_symbol,venue,mint,side,token_decimals,message_hash,expires_at,stub) values ($1,$2,null,$3,$4,$5,$6,'buy',$7,'unused',now()-interval '10 minutes',false)",
    ["expired-unfilled", wallet, token.ticker, token.symbol, token.issuer, token.mint, token.decimals],
  );
  const sellResponse = await quote(post("quote", { ...quoteBody, side: "sell", tokenAmount: 0.1 }));
  assert.equal((await db.query("select request_id from copy_orders where request_id='expired-unfilled'")).rows.length, 0);
  assert.equal((await db.query("select request_id from copy_orders where request_id=$1", [order.requestId])).rows.length, 1);
  const sellOrder = (await sellResponse.json()).order;
  const sellTx = transactions.get(sellOrder.requestId)!; sellTx.sign([signer]);
  const sellBody = { wallet, requestId: sellOrder.requestId, signedTransaction: Buffer.from(sellTx.serialize()).toString("base64") };
  const sellReceipt = await (await execute(post("execute", sellBody))).json();
  assert.equal(sellReceipt.position.side, "sell");
  assert.equal(sellReceipt.position.inputDecimals, token.decimals);
  assert.equal(sellReceipt.position.outputDecimals, 6);
  jupiterFails = true;
  assert.equal((await execute(post("execute", sellBody))).status, 502);
  assert.equal((await db.query("select * from positions")).rows.length, 2);
  jupiterFails = false;
  receiptWriteFails = true;
  const unsaved = await (await execute(post("execute", sellBody))).json();
  assert.equal(unsaved.persistence, "failed");
  assert.equal(unsaved.result.status, "Success");
  assert.match(unsaved.warning, /Do not repeat/);
  receiptWriteFails = false;
  const expired = (await db.query("select * from copy_orders where request_id=$1", [order.requestId])).rows[0];
  assert.equal(verifyCopyOrder(expired as never, wallet, signed, Date.now() + 120_000), false);
  assert.equal((await quote(post("quote", { ...quoteBody, outputMint: SystemProgram.programId.toBase58() }))).status, 403);
  assert.equal((await quote(post("quote", { ...quoteBody, usdcAmount: 0.99 }))).status, 400);
  omitAmounts = true;
  const missingOrder = (await (await quote(post("quote", quoteBody))).json()).order;
  const missingTx = transactions.get(missingOrder.requestId)!; missingTx.sign([signer]);
  const missing = await (await execute(post("execute", { wallet, requestId: missingOrder.requestId, signedTransaction: Buffer.from(missingTx.serialize()).toString("base64"), inAmount: "99999", outAmount: "99999" }))).json();
  assert.equal(missing.persistence, "saved");
  assert.equal(missing.position.inputAmountRaw, null);
  assert.equal(missing.position.outputAmountRaw, null);
  assert.equal((await execute(post("execute", { wallet, requestId: "stub-forged", signedTransaction: "privy-stub:forged" }))).status, 400);
  assert.equal((await quote(post("quote", null))).status, 400);
  assert.equal((await execute(post("execute", null))).status, 400);
  assert.equal((await basketQuote()).status, 503);
  assert.equal((await basketExecute()).status, 503);
});

test("receipt presentation preserves exact atomic units, missing amounts, sell direction and wallet identity", () => {
  assert.equal(formatReceiptAmount("9007199254740993123", 6), "9007199254740.993123");
  assert.equal(formatReceiptAmount(null, 6), "Unavailable");
  const receipt: TrackedPosition = { id: "test", wallet: "owner", disclosureId: null, ticker: "TEST", tokenSymbol: "TESTx", venue: "xstock", mint: "test-mint", side: "sell", inputAmountRaw: "123450000", outputAmountRaw: null, inputDecimals: 8, outputDecimals: 6, requestId: "test-request", signature: "test-signature", stub: false, createdAt: "2026-09-15T00:00:00Z" };
  const html = renderToStaticMarkup(createElement(CopyReceiptRows, { address: "owner", positions: [receipt] }));
  assert.match(html, /Sell TESTx/);
  assert.match(html, /1\.2345 TESTx/);
  assert.match(html, /Unavailable USDC/);
  assert.doesNotMatch(html, /\$0|cluster=devnet/);
  const mismatch = renderToStaticMarkup(createElement(CopyReceiptRows, { address: "other", positions: [receipt] }));
  assert.match(mismatch, /Receipt wallet mismatch/);
  assert.doesNotMatch(mismatch, /test-signature/);
});
