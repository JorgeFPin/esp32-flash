// Cifra dos firmwares de clientes (AES-256-GCM). Funciona no browser e no Node.js 18+.
//
// Formato de um ficheiro cifrado: "EFW1" (4 bytes) + IV (12 bytes) + dados cifrados + tag (16 bytes).
// O "contexto" (ex.: o caminho do ficheiro) entra como dados autenticados: um ficheiro cifrado
// não pode ser trocado por outro do mesmo cliente sem a decifração falhar.

const MAGIC = [0x45, 0x46, 0x57, 0x31]; // "EFW1"
const KEY_BYTES = 32;
const IV_BYTES = 12;

async function webcrypto() {
  if (globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto;
  const m = await import("node:crypto");
  return m.webcrypto;
}

export function b64urlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text) {
  const s = String(text).trim().replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Gera uma chave nova (texto de 43 caracteres, seguro para usar em links). */
export async function novaChave() {
  const c = await webcrypto();
  return b64urlEncode(c.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/** Valida o formato de uma chave (não diz se é a chave certa). */
export function chaveValida(chave) {
  try {
    return /^[A-Za-z0-9_-]{43}$/.test(chave) && b64urlDecode(chave).length === KEY_BYTES;
  } catch (e) {
    return false;
  }
}

async function importarChave(chave) {
  if (!chaveValida(chave)) throw new Error("Código de acesso com formato inválido.");
  const c = await webcrypto();
  return c.subtle.importKey("raw", b64urlDecode(chave), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Cifra `dados` (Uint8Array). */
export async function cifrar(chave, dados, contexto) {
  const c = await webcrypto();
  const key = await importarChave(chave);
  const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await c.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(contexto) }, key, dados)
  );
  const out = new Uint8Array(MAGIC.length + IV_BYTES + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(ct, MAGIC.length + IV_BYTES);
  return out;
}

/** Decifra um ficheiro produzido por `cifrar`. Lança erro se a chave estiver errada. */
export async function decifrar(chave, blob, contexto) {
  if (blob.length < MAGIC.length + IV_BYTES + 16 || MAGIC.some((m, i) => blob[i] !== m)) {
    throw new Error("O ficheiro não é um firmware cifrado válido.");
  }
  const c = await webcrypto();
  const key = await importarChave(chave);
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  try {
    const pt = await c.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(contexto) },
      key,
      blob.subarray(MAGIC.length + IV_BYTES)
    );
    return new Uint8Array(pt);
  } catch (e) {
    const err = new Error("Código de acesso errado ou ficheiro alterado.");
    err.chaveErrada = true;
    throw err;
  }
}

export async function cifrarJSON(chave, obj, contexto) {
  return cifrar(chave, new TextEncoder().encode(JSON.stringify(obj)), contexto);
}

export async function decifrarJSON(chave, blob, contexto) {
  return JSON.parse(new TextDecoder().decode(await decifrar(chave, blob, contexto)));
}

// Contextos usados nos dados autenticados.
export const contextoCatalogo = (clienteId) => `catalogo:${clienteId}`;
export const contextoFicheiro = (caminho) => `ficheiro:${caminho}`;
