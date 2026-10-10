#!/usr/bin/env node
// Publica uma nova versão de firmware no "ESP32 Flash via WEB".
//
// Firmware PÚBLICO (qualquer pessoa com o link pode instalar):
//   node tools/publicar-firmware.mjs --produto termostato --nome "Termostato" --versao 1.2.0 \
//        --esp32 C:\caminho\sketch.ino.merged.bin --esp32s3 C:\caminho\sketch_s3.ino.merged.bin
//
// Firmware de um CLIENTE (cifrado; só abre com o link/código desse cliente):
//   node tools/publicar-firmware.mjs --cliente "Hotel Sol" --produto termostato --nome "Termostato" \
//        --versao 1.2.0 --esp32 C:\caminho\sketch.ino.merged.bin
//
// Ver MANUAL.md para o processo completo.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  FW_DIR,
  parseArgs,
  fail,
  checkFirmware,
  readPublicCatalog,
  writePublicCatalog,
  loadSecrets,
  findClient,
  readClientCatalog,
  writeClientCatalog,
  clientDir,
  relFw,
  encryptFile,
  link,
  assertSecretsNotTracked,
} from "./lib.mjs";

function usage(msg) {
  if (msg) console.error("Erro: " + msg + "\n");
  console.error(`Utilização:
  node tools/publicar-firmware.mjs --produto <id> --versao <x.y.z> [--cliente "<nome ou id>"]
       [--nome "Nome"] [--descricao "..."] [--notas "..."] [--data AAAA-MM-DD]
       [--manter-dados nao] [--substituir]
       --esp32 <ficheiro.merged.bin> [--esp32s3 <ficheiro.merged.bin>] ...

  --cliente       publica cifrado, só para esse cliente (criar antes com: node tools/clientes.mjs novo)
                  sem --cliente o firmware fica público
  --produto       identificador do produto (letras minúsculas, números e "-"), usado no link
  --versao        versão a publicar (ex.: 1.2.0)
  --nome          nome mostrado ao cliente (obrigatório na 1.ª publicação do produto)
  --descricao     descrição curta do produto
  --notas         notas desta versão (mostradas ao cliente)
  --data          data da versão (por defeito, hoje)
  --manter-dados  "nao" obriga a apagar as definições guardadas na placa ao instalar esta versão
  --substituir    permite substituir uma versão já publicada
  --esp32, --esp32s3, --esp32s2, --esp32c3, --esp32c6   ficheiro .merged.bin de cada chip`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2), ["substituir", "ajuda", "help"]);
if (args.ajuda || args.help) usage();
if (args._.length) usage(`argumento inesperado "${args._[0]}"`);
if (!args.produto || !/^[a-z0-9][a-z0-9-]*$/.test(args.produto)) usage("--produto inválido ou em falta");
if (!args.versao || !/^[0-9A-Za-z.+-]+$/.test(args.versao)) usage("--versao inválida ou em falta");
if (!Object.keys(args.files).length) usage("indique pelo menos um ficheiro (--esp32 / --esp32s3 …)");

// Cliente (opcional)
let client = null;
if (args.cliente) {
  assertSecretsNotTracked();
  client = findClient(loadSecrets(), args.cliente);
}

const catalog = client ? await readClientCatalog(client) : readPublicCatalog();
let product = catalog.produtos.find((p) => p.id === args.produto);
if (!product) {
  if (!args.nome) usage(`o produto "${args.produto}" é novo: indique --nome`);
  product = { id: args.produto, nome: args.nome, descricao: args.descricao || "", versoes: [] };
  catalog.produtos.push(product);
} else {
  if (args.nome) product.nome = args.nome;
  if (args.descricao) product.descricao = args.descricao;
}

const existing = product.versoes.findIndex((v) => v.versao === args.versao);
if (existing >= 0 && !args.substituir) {
  usage(`a versão ${args.versao} de ${args.produto} já existe (use --substituir para a substituir)`);
}

// Valida todos os ficheiros antes de escrever o que quer que seja.
const destDir = client
  ? path.join(clientDir(client), args.produto, args.versao)
  : path.join(FW_DIR, args.produto, args.versao);
const checked = [];
let failed = false;
for (const [chip, src] of Object.entries(args.files)) {
  const r = checkFirmware(chip, src);
  if (r.error) {
    console.error("✕ " + r.error);
    failed = true;
    continue;
  }
  const name = `${args.produto}-v${args.versao}-${chip.toLowerCase().replace(/-/g, "")}.bin${client ? ".enc" : ""}`;
  checked.push({ chip, src, name, ...r });
}
if (failed) {
  console.error("\nNada foi publicado. Corrija os erros acima e repita.");
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
const ficheiros = {};
for (const f of checked) {
  const abs = path.join(destDir, f.name);
  const rel = relFw(abs);
  // Firmware de cliente: comprimido (gzip) e depois cifrado.
  const data = client ? await encryptFile(client.chave, rel, zlib.gzipSync(f.bytes, { level: 9 })) : f.bytes;
  fs.writeFileSync(abs, data);
  ficheiros[f.chip] = { ficheiro: rel, tamanho: f.bytes.length, md5: f.md5 };
  const size = client ? `${(f.bytes.length / 1024).toFixed(0)} KB → ${(data.length / 1024).toFixed(0)} KB comprimido e cifrado` : `${(f.bytes.length / 1024).toFixed(0)} KB`;
  console.log(`✓ ${f.chip}: ${path.basename(f.src)} → docs/firmware/${rel} (${size}, flash ${f.info.flashSize})`);
}

const release = {
  versao: args.versao,
  data: args.data || new Date().toISOString().slice(0, 10),
  notas: args.notas || "",
  ficheiros,
};
if (args["manter-dados"] && /^(nao|não|no|false|0)$/i.test(args["manter-dados"])) release.manterDados = false;
if (existing >= 0) product.versoes.splice(existing, 1);
product.versoes.unshift(release);

if (client) {
  await writeClientCatalog(client, catalog);
  console.log(`\n✓ ${product.nome} v${args.versao} publicado para o cliente "${client.nome}" (docs/firmware/clientes/${client.id}/)`);
  console.log(`\n  Link para enviar ao cliente (contém a chave — envie só a este cliente):`);
  console.log(`  ${link({ cliente: client.id, produto: product.id, chave: client.chave })}`);
} else {
  writePublicCatalog(catalog);
  console.log(`\n✓ ${product.nome} v${args.versao} publicado (público) em docs/firmware/catalog.json`);
  console.log(`\n  Link: ${link({ produto: product.id })}`);
}
console.log(`\n  Falta enviar para o GitHub:\n  git add docs/firmware && git commit -m "${product.nome} v${args.versao}" && git push`);
