// Stage llama-server.exe + its runtime DLLs for bundling as installer
// resources (решение Р-5: llama-server кладётся инсталлером, качаются только
// веса). Source: an existing llama.cpp install; by default the app's own dir
// %APPDATA%\com.stas.pdfer\llama, override with PDFER_LLAMA_SRC. Destination:
// <repo>/llama-bin (gitignored) — tauri.conf.json bundles it into
// <resource_dir>/llama/, and lib.rs prefers that copy over the appdata one.
//
// Only what llama-server actually needs is staged: the server shim + impl,
// the llama/ggml core, every ggml-cpu-* variant (runtime CPU dispatch),
// the Vulkan backend and the OpenMP runtime. Other llama.cpp tools
// (llama-cli, llama-bench, ...) and their per-tool impl DLLs stay behind.
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src =
  process.env.PDFER_LLAMA_SRC ||
  join(process.env.APPDATA || "", "com.stas.pdfer", "llama");
const dst = join(root, "llama-bin");

const WANTED_EXACT = new Set([
  "llama-server.exe",
  "llama-server-impl.dll",
  "llama-common.dll",
  "llama.dll",
  "ggml.dll",
  "ggml-base.dll",
  "ggml-vulkan.dll",
  "ggml-rpc.dll",
  "libomp140.x86_64.dll",
  "mtmd.dll",
]);
const wanted = (name) =>
  WANTED_EXACT.has(name) || /^ggml-cpu-.+\.dll$/i.test(name);

let names;
try {
  names = readdirSync(src).filter(wanted);
} catch (e) {
  console.error(`stage-llama: source dir not readable: ${src}\n${e.message}`);
  console.error(
    "stage-llama: set PDFER_LLAMA_SRC to a llama.cpp dir containing llama-server.exe",
  );
  process.exit(1);
}
if (!names.includes("llama-server.exe")) {
  console.error(`stage-llama: llama-server.exe not found in ${src}`);
  process.exit(1);
}

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
let total = 0;
for (const name of names.sort()) {
  copyFileSync(join(src, name), join(dst, name));
  total += statSync(join(dst, name)).size;
}
console.log(
  `stage-llama: staged ${names.length} files, ${(total / 1024 / 1024).toFixed(1)} MB -> ${dst}`,
);
