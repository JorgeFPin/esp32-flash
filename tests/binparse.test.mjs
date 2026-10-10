// Testes: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { analyzeFirmware, buildSegments, samePartitions } from "../docs/js/binparse.js";
import { md5 } from "../docs/js/md5.js";

const ESP32 = new Uint8Array(fs.readFileSync(new URL("../docs/firmware/demo/1.0.0/demo-v1.0.0-esp32.bin", import.meta.url)));
const ESP32S3 = new Uint8Array(fs.readFileSync(new URL("../docs/firmware/demo/1.0.0/demo-v1.0.0-esp32s3.bin", import.meta.url)));

test("md5 igual ao do Node", () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 1000, 4096 + 3]) {
    const b = crypto.randomBytes(len);
    assert.equal(md5(new Uint8Array(b)), crypto.createHash("md5").update(b).digest("hex"), `len ${len}`);
  }
  assert.equal(md5(ESP32), crypto.createHash("md5").update(ESP32).digest("hex"));
});

test("merged.bin ESP32: bootloader em 0x1000, gravar em 0x0", () => {
  const r = analyzeFirmware(ESP32);
  assert.equal(r.ok, true);
  assert.equal(r.kind, "merged");
  assert.equal(r.chip, "ESP32");
  assert.equal(r.address, 0);
  assert.equal(r.bootloaderOffset, 0x1000);
  assert.equal(r.flashSize, "4MB");
  assert.equal(r.appOffset, 0x10000);
  assert.deepEqual(r.partitions.map((p) => p.label), ["nvs", "otadata", "app0", "app1", "spiffs", "coredump"]);
});

test("merged.bin ESP32-S3: bootloader em 0x0", () => {
  const r = analyzeFirmware(ESP32S3);
  assert.equal(r.ok, true);
  assert.equal(r.kind, "merged");
  assert.equal(r.chip, "ESP32-S3");
  assert.equal(r.bootloaderOffset, 0);
});

test("só a aplicação: gravar em 0x10000 com aviso", () => {
  const app = ESP32.subarray(0x10000, 0x10000 + 300000);
  const r = analyzeFirmware(app);
  assert.equal(r.kind, "app");
  assert.equal(r.chip, "ESP32");
  assert.equal(r.address, 0x10000);
  assert.equal(r.warnings.length, 1);
});

test("ficheiros inválidos são rejeitados", () => {
  assert.equal(analyzeFirmware(new Uint8Array(100)).ok, false);
  assert.equal(analyzeFirmware(new Uint8Array(50000).fill(0x41)).ok, false);
  const pt = analyzeFirmware(ESP32.slice(0x8000, 0x8000 + 0xc00));
  assert.equal(pt.ok, false);
  assert.match(pt.errors[0], /tabela de partições/);
  const boot = analyzeFirmware(ESP32.slice(0x1000, 0x8000));
  assert.equal(boot.ok, false);
  assert.match(boot.errors[0], /bootloader/);
});

test("bootloader no sítio errado para o chip", () => {
  const moved = new Uint8Array(ESP32S3.length).fill(0xff);
  moved.set(ESP32S3.subarray(0, 0x7000), 0x1000); // bootloader S3 deslocado para 0x1000
  moved.set(ESP32S3.subarray(0x8000), 0x8000);
  const r = analyzeFirmware(moved);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /deveria estar em 0x0/);
});

test("segmentos mantêm nvs e spiffs e cobrem o resto", () => {
  const info = analyzeFirmware(ESP32);
  const { segments, kept } = buildSegments(ESP32, info.partitions);
  assert.deepEqual(kept.map((p) => p.label), ["nvs", "spiffs"]);
  assert.deepEqual(
    segments.map((s) => [s.address, s.data.length]),
    [
      [0x0, 0x9000],
      [0xe000, 0x290000 - 0xe000],
      [0x3f0000, 0x10000],
    ]
  );
  for (const s of segments) assert.equal(s.address % 0x1000, 0);
  assert.equal(samePartitions(info.partitions, analyzeFirmware(ESP32S3).partitions), true);
  assert.equal(samePartitions(info.partitions, info.partitions.slice(1)), false);
});
