#!/usr/bin/env node
// Publica uma nova versão de firmware no catálogo do "ESP32 Flash via WEB".
//
// Exemplo (Windows / macOS / Linux, precisa do Node.js 18+):
//   node tools/publicar-firmware.mjs --produto intelitherm --nome "InteliTherm" \
//        --versao 1.2.0 --notas "Correções de estabilidade" \
//        --esp32 C:\caminho\sketch.ino.merged.bin --esp32s3 C:\caminho\sketch_s3.ino.merged.bin
//
// Copia os .bin para docs/firmware/<produto>/<versao>/, calcula MD5/tamanho e põe a
// versão no topo de docs/firmware/catalog.json (a primeira versão da lista é a "última").
// Depois é só fazer commit + push.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeFirmware } from "../docs/js/binparse.js";
import { md5 } from "../docs/js/md5.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FW_DIR = path.join(ROOT, "docs", "firmware");
const CATALOG = path.join(FW_DIR, "catalog.json");

const CHIP_FLAGS = {
  esp32: "ESP32",
  esp32s3: "ESP32-S3",
  esp32s2: "ESP32-S2",
  esp32c3: "ESP32-C3",
  esp32c6: "ESP32-C6",
};

function usage(msg) {
  if (msg) console.error("Erro: " + msg + "\n");
  console.error(`Utilização:
  node tools/publicar-firmware.mjs --produto <id> --versao <x.y.z> [--nome "Nome"] [--descricao "..."]
       [--notas "..."] [--data AAAA-MM-DD] [--manter-dados nao] [--substituir]
       --esp32 <ficheiro.bin> [--esp32s3 <ficheiro.bin>] ...

  --produto       identificador usado no link (?produto=<id>), só letras minúsculas, números e "-"
  --versao        versão a publicar (ex.: 1.2.0)
  --nome          nome mostrado ao cliente (obrigatório na 1.ª publicação do produto)
  --descricao     descrição curta do produto
  --notas         notas desta versão (mostradas ao cliente)
  --manter-dados  "nao" obriga a apagar as definições guardadas na placa ao instalar esta versão
  --substituir    permite substituir uma versão já publicada
  --esp32, --esp32s3, --esp32s2, --esp32c3, --esp32c6   ficheiro .merged.bin para cada chip`);
  process.exit(1);
}

function parseArgs(argv) {
  const a = { files: {} };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) usage(`argumento inesperado "${k}"`);
    const key = k.slice(2);
    if (key === "substituir") {
      a.substituir = true;
      continue;
    }
    if (key === "ajuda" || key === "help") usage();
    const v = argv[++i];
    if (v === undefined) usage(`falta o valor de ${k}`);
    if (CHIP_FLAGS[key]) a.files[CHIP_FLAGS[key]] = v;
    else a[key] = v;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.produto || !/^[a-z0-9][a-z0-9-]*$/.test(args.produto)) usage("--produto inválido ou em falta");
if (!args.versao || !/^[0-9A-Za-z.+-]+$/.test(args.versao)) usage("--versao inválida ou em falta");
if (!Object.keys(args.files).length) usage("indique pelo menos um ficheiro (--esp32 / --esp32s3 …)");

const catalog = fs.existsSync(CATALOG)
  ? JSON.parse(fs.readFileSync(CATALOG, "utf8"))
  : { produtos: [] };
catalog.produtos = catalog.produtos || [];

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

const destDir = path.join(FW_DIR, args.produto, args.versao);

const ficheiros = {};
const toWrite = [];
let failed = false;
for (const [chip, src] of Object.entries(args.files)) {
  if (!fs.existsSync(src)) {
    console.error(`✕ ${chip}: ficheiro não encontrado: ${src}`);
    failed = true;
    continue;
  }
  const bytes = new Uint8Array(fs.readFileSync(src));
  const info = analyzeFirmware(bytes);
  if (!info.ok) {
    console.error(`✕ ${chip}: ${path.basename(src)} não é válido:\n   - ${info.errors.join("\n   - ")}`);
    failed = true;
    continue;
  }
  if (info.chip !== chip) {
    console.error(`✕ ${chip}: ${path.basename(src)} foi compilado para ${info.chip}, não para ${chip}.`);
    failed = true;
    continue;
  }
  if (info.kind !== "merged") {
    console.error(
      `✕ ${chip}: ${path.basename(src)} contém só a aplicação. Use o ficheiro .merged.bin ` +
        "(Arduino IDE: Sketch → Exportar binário compilado)."
    );
    failed = true;
    continue;
  }
  const name = `${args.produto}-v${args.versao}-${chip.toLowerCase().replace(/-/g, "")}.bin`;
  toWrite.push({ name, bytes });
  ficheiros[chip] = {
    ficheiro: `${args.produto}/${args.versao}/${name}`,
    tamanho: bytes.length,
    md5: md5(bytes),
  };
  console.log(`✓ ${chip}: ${path.basename(src)} → docs/firmware/${ficheiros[chip].ficheiro} (${(bytes.length / 1024).toFixed(0)} KB, flash ${info.flashSize})`);
}
if (failed) {
  console.error("\nNada foi publicado no catálogo. Corrija os erros acima e repita.");
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
for (const f of toWrite) fs.writeFileSync(path.join(destDir, f.name), f.bytes);

const release = {
  versao: args.versao,
  data: args.data || new Date().toISOString().slice(0, 10),
  notas: args.notas || "",
  ficheiros,
};
if (args["manter-dados"] && /^(nao|não|no|false|0)$/i.test(args["manter-dados"])) release.manterDados = false;

if (existing >= 0) product.versoes.splice(existing, 1);
product.versoes.unshift(release);

fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + "\n");
console.log(`\n✓ ${product.nome} v${args.versao} publicado em docs/firmware/catalog.json`);
console.log(`  Link para clientes: <endereço do site>/?produto=${args.produto}`);
console.log("  Falta: git add docs/firmware && git commit -m \"Firmware ...\" && git push");
