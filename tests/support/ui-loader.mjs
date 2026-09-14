// Test-only loader: execute real React components in Node without a browser or bundler.
// CSS class identity is irrelevant to these semantic-render tests; styling is checked separately.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = new URL(`../../src/${specifier.slice(2)}`, import.meta.url);
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      try { return await nextResolve(`${base.href}${suffix}`, context); } catch { /* try the next extension */ }
    }
  }
  if (specifier === "next/link") return nextResolve("next/link.js", context);
  try { return await nextResolve(specifier, context); } catch (error) {
    if (specifier.startsWith(".")) {
      for (const suffix of [".ts", ".tsx"]) {
        try { return await nextResolve(`${specifier}${suffix}`, context); } catch { /* try the next extension */ }
      }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) return { format: "module", shortCircuit: true, source: "export default new Proxy({}, {get: (_, key) => String(key)});" };
  if (url.endsWith(".tsx")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    return { format: "module", shortCircuit: true, source: compiled.outputText };
  }
  return nextLoad(url, context);
}
