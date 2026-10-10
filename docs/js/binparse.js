// Análise de ficheiros .bin de ESP32 (sem dependências; funciona no browser e no Node).
//
// Reconhece:
//  - binário completo / "merged" (bootloader + partições + app), gravado em 0x0
//  - só a aplicação (sketch.ino.bin), gravado em 0x10000
// e extrai o chip a que se destina, o tamanho de flash do cabeçalho, a tabela de
// partições e a descrição da aplicação (nome do projeto, versão, data de compilação).

export const ESP_IMAGE_MAGIC = 0xe9;
const PARTITION_MAGIC = [0xaa, 0x50];
const PARTITION_MD5_MAGIC = [0xeb, 0xeb];
const APP_DESC_MAGIC = 0xabcd5432;
const APP_DEFAULT_OFFSET = 0x10000;

// IDs de chip gravados no cabeçalho estendido da imagem (ver esptool: IMAGE_CHIP_ID).
export const CHIP_BY_ID = {
  0: "ESP32",
  2: "ESP32-S2",
  5: "ESP32-C3",
  9: "ESP32-S3",
  12: "ESP32-C2",
  13: "ESP32-C6",
  16: "ESP32-H2",
  18: "ESP32-P4",
  20: "ESP32-C61",
  23: "ESP32-C5",
};

// Endereço do bootloader em cada família.
export const BOOTLOADER_OFFSET = {
  ESP32: 0x1000,
  "ESP32-S2": 0x1000,
  "ESP32-P4": 0x2000,
  "ESP32-C5": 0x2000,
};
export function bootloaderOffsetFor(chip) {
  return BOOTLOADER_OFFSET[chip] ?? 0x0;
}

const FLASH_SIZES = ["1MB", "2MB", "4MB", "8MB", "16MB", "32MB", "64MB", "128MB"];
const FLASH_MODES = ["QIO", "QOUT", "DIO", "DOUT"];

export function flashSizeToBytes(size) {
  const m = /^(\d+)\s*(KB|MB)$/i.exec(size || "");
  if (!m) return 0;
  return parseInt(m[1], 10) * (m[2].toUpperCase() === "MB" ? 1024 * 1024 : 1024);
}

export function hex(n) {
  return "0x" + n.toString(16).toUpperCase();
}

function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function cstr(b, o, len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = b[o + i];
    if (c === 0 || c === undefined) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/** Lê o cabeçalho de uma imagem ESP (bootloader ou app) que começa em `off`. */
export function readImageHeader(b, off) {
  if (off + 24 > b.length || b[off] !== ESP_IMAGE_MAGIC) return null;
  const sizeFreq = b[off + 3];
  const chipId = u16(b, off + 12);
  return {
    segments: b[off + 1],
    flashMode: FLASH_MODES[b[off + 2]] ?? `? (${b[off + 2]})`,
    flashSize: FLASH_SIZES[sizeFreq >> 4] ?? null,
    chipId,
    chip: CHIP_BY_ID[chipId] ?? null,
  };
}

/** Lê esp_app_desc_t (fica logo a seguir ao 1.º cabeçalho de segmento da app). */
export function readAppDesc(b, off) {
  const d = off + 24 + 8;
  if (d + 256 > b.length || u32(b, d) !== APP_DESC_MAGIC) return null;
  return {
    version: cstr(b, d + 16, 32),
    project: cstr(b, d + 48, 32),
    time: cstr(b, d + 80, 16),
    date: cstr(b, d + 96, 16),
    idf: cstr(b, d + 112, 32),
  };
}

const PART_TYPES = { 0: "app", 1: "data" };
const APP_SUBTYPES = { 0x00: "factory", 0x20: "test" };
const DATA_SUBTYPES = {
  0x00: "ota",
  0x01: "phy",
  0x02: "nvs",
  0x03: "coredump",
  0x04: "nvs_keys",
  0x05: "efuse",
  0x80: "esphttpd",
  0x81: "fat",
  0x82: "spiffs",
  0x83: "littlefs",
};

/** Lê a tabela de partições em `off` (devolve null se não existir). */
export function readPartitionTable(b, off) {
  if (off + 32 > b.length || b[off] !== PARTITION_MAGIC[0] || b[off + 1] !== PARTITION_MAGIC[1]) {
    return null;
  }
  const parts = [];
  for (let p = off; p + 32 <= b.length && p < off + 0xc00; p += 32) {
    if (b[p] === PARTITION_MD5_MAGIC[0] && b[p + 1] === PARTITION_MD5_MAGIC[1]) break;
    if (b[p] !== PARTITION_MAGIC[0] || b[p + 1] !== PARTITION_MAGIC[1]) break;
    const type = b[p + 2];
    const subtype = b[p + 3];
    let subtypeName;
    if (type === 0) {
      subtypeName =
        APP_SUBTYPES[subtype] ??
        (subtype >= 0x10 && subtype < 0x20 ? `ota_${subtype - 0x10}` : hex(subtype));
    } else {
      subtypeName = DATA_SUBTYPES[subtype] ?? hex(subtype);
    }
    parts.push({
      label: cstr(b, p + 12, 16),
      type: PART_TYPES[type] ?? hex(type),
      subtype: subtypeName,
      offset: u32(b, p + 4),
      size: u32(b, p + 8),
    });
  }
  return parts.length ? parts : null;
}

/**
 * Analisa um ficheiro de firmware.
 * @param {Uint8Array} b conteúdo do ficheiro
 * @returns {{
 *   ok: boolean, kind: "merged"|"app"|"unknown", kindLabel: string, address: number,
 *   chip: string|null, flashSize: string|null, flashMode: string|null, bootloaderOffset: number|null,
 *   partitions: Array|null, app: object|null, appOffset: number|null, size: number,
 *   errors: string[], warnings: string[]
 * }}
 */
export function analyzeFirmware(b) {
  const r = {
    ok: false,
    kind: "unknown",
    kindLabel: "Desconhecido",
    address: 0,
    chip: null,
    flashSize: null,
    flashMode: null,
    bootloaderOffset: null,
    partitions: null,
    app: null,
    appOffset: null,
    size: b.length,
    errors: [],
    warnings: [],
  };

  if (b.length < 1024) {
    r.errors.push("O ficheiro é demasiado pequeno para ser um firmware de ESP32.");
    return r;
  }

  // 1) Binário completo: bootloader (0x0 / 0x1000 / 0x2000) + tabela de partições.
  let ptOffset = null;
  for (const off of [0x8000, 0x9000, 0xa000, 0xc000]) {
    if (readPartitionTable(b, off)) {
      ptOffset = off;
      break;
    }
  }
  if (ptOffset !== null) {
    let boot = null;
    for (const off of [0x0, 0x1000, 0x2000]) {
      const h = readImageHeader(b, off);
      if (h && h.chip) {
        boot = { off, h };
        break;
      }
    }
    if (boot) {
      r.kind = "merged";
      r.kindLabel = "Binário completo (bootloader + partições + aplicação)";
      r.address = 0x0;
      r.chip = boot.h.chip;
      r.flashSize = boot.h.flashSize;
      r.flashMode = boot.h.flashMode;
      r.bootloaderOffset = boot.off;
      r.partitions = readPartitionTable(b, ptOffset);

      const expected = bootloaderOffsetFor(boot.h.chip);
      if (expected !== boot.off) {
        r.errors.push(
          `O bootloader está em ${hex(boot.off)}, mas no ${boot.h.chip} deveria estar em ${hex(expected)}. ` +
            "O ficheiro parece estar corrompido ou foi mal gerado."
        );
      }

      const appPart =
        r.partitions.find((p) => p.type === "app" && p.subtype === "factory") ||
        r.partitions.find((p) => p.type === "app" && p.subtype === "ota_0") ||
        r.partitions.find((p) => p.type === "app");
      if (appPart) {
        r.appOffset = appPart.offset;
        const ah = readImageHeader(b, appPart.offset);
        if (!ah) {
          r.errors.push(
            `Não foi encontrada a aplicação em ${hex(appPart.offset)} (partição "${appPart.label}"). ` +
              "O ficheiro pode estar incompleto."
          );
        } else {
          if (ah.chip && ah.chip !== r.chip) {
            r.errors.push(`O bootloader é para ${r.chip} mas a aplicação é para ${ah.chip}.`);
          }
          r.app = readAppDesc(b, appPart.offset);
        }
      }
      r.ok = r.errors.length === 0;
      return r;
    }
  }

  // 2) Só a aplicação (sketch.ino.bin).
  const h = readImageHeader(b, 0);
  if (h) {
    const desc = readAppDesc(b, 0);
    r.chip = h.chip;
    r.flashSize = h.flashSize;
    r.flashMode = h.flashMode;
    if (!h.chip) {
      r.errors.push(`Chip desconhecido no cabeçalho (ID ${h.chipId}).`);
    }
    if (desc) {
      r.kind = "app";
      r.kindLabel = "Só a aplicação (sem bootloader nem partições)";
      r.address = APP_DEFAULT_OFFSET;
      r.app = desc;
      r.appOffset = 0;
      r.warnings.push(
        "Este ficheiro contém só a aplicação e vai ser gravado em 0x10000. Só funciona se a placa já tiver " +
          "o bootloader e a tabela de partições corretos. Para clientes use de preferência o ficheiro " +
          '".merged.bin" (Arduino IDE: Sketch → Exportar binário compilado).'
      );
    } else {
      r.errors.push(
        "Este ficheiro parece ser apenas o bootloader. Use o ficheiro completo \".merged.bin\" " +
          "(Arduino IDE: Sketch → Exportar binário compilado)."
      );
    }
    r.ok = r.errors.length === 0;
    return r;
  }

  if (readPartitionTable(b, 0)) {
    r.errors.push(
      "Este ficheiro é só a tabela de partições (partitions.bin). Use o ficheiro completo \".merged.bin\"."
    );
  } else {
    r.errors.push(
      "Este ficheiro não parece ser um firmware de ESP32 (não tem o cabeçalho de imagem ESP). " +
        "Confirme que escolheu o ficheiro .bin correto."
    );
  }
  return r;
}

// Partições de dados que podem ser mantidas numa atualização (definições e ficheiros do utilizador).
export const PRESERVABLE_SUBTYPES = ["nvs", "nvs_keys", "spiffs", "littlefs", "fat"];

/** true se as duas tabelas de partições forem iguais. */
export function samePartitions(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every(
    (p, i) =>
      p.label === b[i].label && p.type === b[i].type && p.subtype === b[i].subtype &&
      p.offset === b[i].offset && p.size === b[i].size
  );
}

/**
 * Divide um binário completo (gravado em 0x0) em blocos, saltando as partições de dados
 * a manter. Devolve [{ address, data }] e a lista de partições mantidas.
 */
export function buildSegments(bytes, partitions, keepSubtypes = PRESERVABLE_SUBTYPES) {
  const skips = (partitions || [])
    .filter((p) => p.type === "data" && keepSubtypes.includes(p.subtype) && p.offset < bytes.length)
    .sort((x, y) => x.offset - y.offset);
  const segments = [];
  let pos = 0;
  for (const p of skips) {
    if (p.offset > pos) segments.push({ address: pos, data: bytes.subarray(pos, p.offset) });
    pos = Math.max(pos, Math.min(p.offset + p.size, bytes.length));
  }
  if (pos < bytes.length) segments.push({ address: pos, data: bytes.subarray(pos) });
  return { segments, kept: skips };
}
