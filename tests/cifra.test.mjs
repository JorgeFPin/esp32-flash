// Testes da cifra e do fluxo de clientes: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  novaChave,
  chaveValida,
  cifrar,
  decifrar,
  decifrarJSON,
  contextoCatalogo,
  contextoFicheiro,
  b64urlDecode,
} from "../docs/js/cifra.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("chave nova: 43 caracteres seguros para URL e 32 bytes", async () => {
  const k = await novaChave();
  assert.match(k, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(b64urlDecode(k).length, 32);
  assert.equal(chaveValida(k), true);
  assert.equal(chaveValida(k.slice(1)), false);
  assert.equal(chaveValida(k + "A"), false);
  assert.notEqual(k, await novaChave());
});

test("cifrar/decifrar: ida e volta, chave errada e contexto errado falham", async () => {
  const k = await novaChave();
  const dados = new Uint8Array(100000).map((_, i) => i % 251);
  const blob = await cifrar(k, dados, "ficheiro:a.bin");
  assert.deepEqual(Array.from(blob.subarray(0, 4)), [0x45, 0x46, 0x57, 0x31]);
  assert.deepEqual(await decifrar(k, blob, "ficheiro:a.bin"), dados);
  await assert.rejects(decifrar(await novaChave(), blob, "ficheiro:a.bin"), (e) => e.chaveErrada === true);
  await assert.rejects(decifrar(k, blob, "ficheiro:b.bin"), (e) => e.chaveErrada === true);
  const mexido = blob.slice();
  mexido[100] ^= 1;
  await assert.rejects(decifrar(k, mexido, "ficheiro:a.bin"), (e) => e.chaveErrada === true);
  // Mesmo conteúdo cifrado duas vezes dá resultados diferentes (IV aleatório).
  assert.notDeepEqual(await cifrar(k, dados, "x"), await cifrar(k, dados, "x"));
});

test("fluxo completo: criar cliente, publicar cifrado, decifrar como a página", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "esp32flash-"));
  // Cópia mínima do repositório para não mexer no verdadeiro.
  for (const d of ["docs/js", "tools"]) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
  fs.mkdirSync(path.join(tmp, "docs/firmware"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
  const bin = path.join(ROOT, "docs/firmware/demo/1.0.0/demo-v1.0.0-esp32.bin");
  const env = { ...process.env, ESP32FLASH_SEGREDOS: path.join(tmp, "segredos.json") };
  const run = (script, ...a) => execFileSync("node", [path.join(tmp, "tools", script), ...a], { cwd: tmp, env }).toString();

  run("clientes.mjs", "novo", "--nome", "Cliente Teste");
  const out = run("publicar-firmware.mjs", "--cliente", "Cliente Teste", "--produto", "p1", "--nome", "Produto 1", "--versao", "2.0.0", "--esp32", bin);
  const url = new URL(out.match(/https:\/\/\S+#k=\S+/)[0]);
  const cid = url.searchParams.get("c");
  const key = new URLSearchParams(url.hash.slice(1)).get("k");
  assert.equal(url.searchParams.get("produto"), "p1");

  const cat = await decifrarJSON(key, new Uint8Array(fs.readFileSync(path.join(tmp, `docs/firmware/clientes/${cid}/catalogo.enc`))), contextoCatalogo(cid));
  assert.equal(cat.cliente, "Cliente Teste");
  const f = cat.produtos[0].versoes[0].ficheiros.ESP32;
  const plain = await decifrar(key, new Uint8Array(fs.readFileSync(path.join(tmp, "docs/firmware", f.ficheiro))), contextoFicheiro(f.ficheiro));
  const original = fs.readFileSync(bin);
  assert.deepEqual(zlib.gunzipSync(plain), original);
  assert.equal(f.tamanho, original.length);

  // Nova chave: a antiga deixa de abrir, a nova abre.
  run("clientes.mjs", "nova-chave", "--cliente", "Cliente Teste");
  const blob = new Uint8Array(fs.readFileSync(path.join(tmp, `docs/firmware/clientes/${cid}/catalogo.enc`)));
  await assert.rejects(decifrarJSON(key, blob, contextoCatalogo(cid)));
  const newKey = JSON.parse(fs.readFileSync(env.ESP32FLASH_SEGREDOS, "utf8")).clientes[0].chave;
  assert.equal((await decifrarJSON(newKey, blob, contextoCatalogo(cid))).produtos.length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});
