// Funções partilhadas pelos scripts de tools/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { analyzeFirmware } from "../docs/js/binparse.js";
import { md5 } from "../docs/js/md5.js";
import { cifrar, decifrar, cifrarJSON, decifrarJSON, novaChave, contextoCatalogo, contextoFicheiro } from "../docs/js/cifra.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FW_DIR = path.join(ROOT, "docs", "firmware");
export const PUBLIC_CATALOG = path.join(FW_DIR, "catalog.json");
export const CLIENTS_DIR = path.join(FW_DIR, "clientes");

// Endereço público do site (pode ser alterado com a variável de ambiente ESP32FLASH_SITE).
export const SITE_URL = (process.env.ESP32FLASH_SITE || "https://jorgefpin.github.io/esp32-flash/").replace(/\/?$/, "/");

// Ficheiro com as chaves dos clientes. NUNCA vai para o GitHub (está no .gitignore).
export const SECRETS_FILE = process.env.ESP32FLASH_SEGREDOS || path.join(ROOT, "segredos", "clientes.json");

export const CHIP_FLAGS = {
  esp32: "ESP32",
  esp32s3: "ESP32-S3",
  esp32s2: "ESP32-S2",
  esp32c3: "ESP32-C3",
  esp32c6: "ESP32-C6",
};

export function fail(msg) {
  console.error("✕ " + msg);
  process.exit(1);
}

/** Lê argumentos do tipo --chave valor; as flags em `booleans` não levam valor. */
export function parseArgs(argv, booleans = []) {
  const a = { _: [], files: {} };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) {
      a._.push(k);
      continue;
    }
    const key = k.slice(2);
    if (booleans.includes(key)) {
      a[key] = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined) fail(`falta o valor de ${k}`);
    if (CHIP_FLAGS[key]) a.files[CHIP_FLAGS[key]] = v;
    else a[key] = v;
  }
  return a;
}

// ------------------------------------------------------------------ segredos

export function loadSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) return { clientes: [] };
  const s = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
  s.clientes = s.clientes || [];
  return s;
}

export function saveSecrets(s) {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  s.aviso =
    "CHAVES DOS CLIENTES — NÃO publicar no GitHub público. Guardar cópia de segurança (ver MANUAL.md, secção Cópia de segurança).";
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(s, null, 2) + "\n");
  assertSecretsNotTracked();
}

/** Confirma que o ficheiro de segredos não está (nem vai ficar) no git. */
export function assertSecretsNotTracked() {
  if (!SECRETS_FILE.startsWith(ROOT + path.sep)) return;
  const rel = path.relative(ROOT, SECRETS_FILE);
  try {
    const tracked = execFileSync("git", ["ls-files", "--", rel], { cwd: ROOT }).toString().trim();
    if (tracked) {
      fail(`ATENÇÃO: ${rel} está no git! Corra "git rm --cached ${rel}" e não faça push das chaves.`);
    }
    execFileSync("git", ["check-ignore", "-q", rel], { cwd: ROOT });
  } catch (e) {
    if (e.status === 1) fail(`ATENÇÃO: ${rel} não está no .gitignore. Acrescente "segredos/" ao .gitignore.`);
    // git não instalado: ignora a verificação
  }
}

export function findClient(secrets, query) {
  if (!query) fail("indique o cliente com --cliente <nome ou id>");
  const q = String(query).toLowerCase();
  const c = secrets.clientes.find((x) => x.id === q || x.nome.toLowerCase() === q);
  if (!c) {
    const nomes = secrets.clientes.map((x) => `"${x.nome}" (${x.id})`).join(", ") || "nenhum";
    fail(`cliente "${query}" não encontrado em ${path.relative(ROOT, SECRETS_FILE)}. Clientes: ${nomes}`);
  }
  return c;
}

export function newClientId(secrets) {
  for (;;) {
    const id = "c" + Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, "0")).join("");
    if (!secrets.clientes.some((x) => x.id === id)) return id;
  }
}

export { novaChave };

// ------------------------------------------------------------------ catálogos

export function readPublicCatalog() {
  if (!fs.existsSync(PUBLIC_CATALOG)) return { produtos: [] };
  const c = JSON.parse(fs.readFileSync(PUBLIC_CATALOG, "utf8"));
  c.produtos = c.produtos || [];
  return c;
}

export function writePublicCatalog(c) {
  fs.writeFileSync(PUBLIC_CATALOG, JSON.stringify(c, null, 2) + "\n");
}

export function clientDir(client) {
  return path.join(CLIENTS_DIR, client.id);
}

export function clientCatalogPath(client) {
  return path.join(clientDir(client), "catalogo.enc");
}

export async function readClientCatalog(client) {
  const p = clientCatalogPath(client);
  if (!fs.existsSync(p)) return { cliente: client.nome, produtos: [] };
  try {
    const c = await decifrarJSON(client.chave, new Uint8Array(fs.readFileSync(p)), contextoCatalogo(client.id));
    c.produtos = c.produtos || [];
    return c;
  } catch (e) {
    fail(`não foi possível abrir o catálogo de ${client.nome}: ${e.message} (a chave em segredos/clientes.json está certa?)`);
  }
}

export async function writeClientCatalog(client, catalog, key = client.chave) {
  catalog.cliente = client.nome;
  fs.mkdirSync(clientDir(client), { recursive: true });
  fs.writeFileSync(clientCatalogPath(client), await cifrarJSON(key, catalog, contextoCatalogo(client.id)));
}

/** Caminho relativo a docs/firmware/ (com "/"), usado no catálogo e no contexto da cifra. */
export function relFw(abs) {
  return path.relative(FW_DIR, abs).split(path.sep).join("/");
}

export async function encryptFile(key, relPath, bytes) {
  return cifrar(key, bytes, contextoFicheiro(relPath));
}

export async function decryptFile(key, relPath, blob) {
  return decifrar(key, blob, contextoFicheiro(relPath));
}

// ------------------------------------------------------------------ firmware

/** Valida um .bin para um chip. Devolve { bytes, info } ou uma mensagem de erro. */
export function checkFirmware(chip, src) {
  if (!fs.existsSync(src)) return { error: `${chip}: ficheiro não encontrado: ${src}` };
  const bytes = new Uint8Array(fs.readFileSync(src));
  const info = analyzeFirmware(bytes);
  const name = path.basename(src);
  if (!info.ok) return { error: `${chip}: ${name} não é válido:\n   - ${info.errors.join("\n   - ")}` };
  if (info.chip !== chip) return { error: `${chip}: ${name} foi compilado para ${info.chip}, não para ${chip}.` };
  if (info.kind !== "merged") {
    return {
      error: `${chip}: ${name} contém só a aplicação. Use o ficheiro .merged.bin (Arduino IDE: Sketch → Exportar binário compilado).`,
    };
  }
  return { bytes, info, md5: md5(bytes) };
}

export function link({ cliente, produto, chave } = {}) {
  const q = new URLSearchParams();
  if (cliente) q.set("c", cliente);
  if (produto) q.set("produto", produto);
  const s = q.toString();
  return SITE_URL + (s ? "?" + s : "") + (chave ? "#k=" + chave : "");
}
