// ESP32 Flash via WEB — by Jorge Pinheiro
// Interface do gravador. A comunicação com o chip é feita pela esptool-js (Espressif).

import { ESPLoader, Transport } from "../vendor/esptool-js/esptool-bundle.js";
import {
  analyzeFirmware,
  readAppDesc,
  readPartitionTable,
  hex,
  flashSizeToBytes,
  buildSegments,
  samePartitions,
} from "./binparse.js";
import { md5 } from "./md5.js";
import { chaveValida, decifrar, decifrarJSON, contextoCatalogo, contextoFicheiro } from "./cifra.js";

// Adaptadores USB-série habituais em placas ESP32 (usados como filtro na escolha da porta).
const USB_FILTERS = [
  { usbVendorId: 0x303a }, // Espressif (USB nativo do ESP32-S3 / C3)
  { usbVendorId: 0x10c4 }, // Silicon Labs CP210x
  { usbVendorId: 0x1a86 }, // WCH CH340 / CH9102
  { usbVendorId: 0x0403 }, // FTDI
  { usbVendorId: 0x067b }, // Prolific
];

const $ = (id) => document.getElementById(id);
const el = {
  unsupported: $("unsupported"),
  productBanner: $("productBanner"),
  pbName: $("pbName"),
  pbDesc: $("pbDesc"),
  pbVersion: $("pbVersion"),
  pbDate: $("pbDate"),
  pbNotes: $("pbNotes"),
  stepBoard: $("stepBoard"),
  stepFirmware: $("stepFirmware"),
  stepConnect: $("stepConnect"),
  stepFlash: $("stepFlash"),
  localFw: $("localFw"),
  dropzone: $("dropzone"),
  fileInput: $("fileInput"),
  catalogFw: $("catalogFw"),
  catalogFwText: $("catalogFwText"),
  fwSummary: $("fwSummary"),
  btnConnect: $("btnConnect"),
  btnDisconnect: $("btnDisconnect"),
  baud: $("baud"),
  connectMsg: $("connectMsg"),
  deviceInfo: $("deviceInfo"),
  eraseAll: $("eraseAll"),
  keepData: $("keepData"),
  keepDataNote: $("keepDataNote"),
  checks: $("checks"),
  btnFlash: $("btnFlash"),
  btnFlashText: $("btnFlashText"),
  progressWrap: $("progressWrap"),
  progressBar: $("progressBar"),
  progressText: $("progressText"),
  progressPct: $("progressPct"),
  flashResult: $("flashResult"),
  addrMode: $("addrMode"),
  addrInput: $("addrInput"),
  allPorts: $("allPorts"),
  ignoreChecks: $("ignoreChecks"),
  monitorBaud: $("monitorBaud"),
  btnMonitor: $("btnMonitor"),
  btnReset: $("btnReset"),
  btnMonitorStop: $("btnMonitorStop"),
  monitorOut: $("monitorOut"),
  log: $("log"),
  btnCopyLog: $("btnCopyLog"),
  btnClearLog: $("btnClearLog"),
  productsCard: $("productsCard"),
  productsTitle: $("productsTitle"),
  productsIntro: $("productsIntro"),
  pbEyebrow: $("pbEyebrow"),
  accessCard: $("accessCard"),
  accessForm: $("accessForm"),
  accessCode: $("accessCode"),
  accessMsg: $("accessMsg"),
  productList: $("productList"),
};

const state = {
  board: "ESP32",
  boardTouched: false,
  keepDataPref: true,
  fw: null, // { name, bytes, info, md5, source }
  port: null,
  transport: null,
  loader: null,
  device: null, // { chip, description, mac, flashSize, features, current }
  busy: false,
  flashed: false,
  monitor: null,
  catalogMode: false,
  product: null,
  release: null,
  client: null, // { id, key, nome } no modo cliente
};

// ---------------------------------------------------------------- utilitários

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
  return (n / 1024).toFixed(1) + " KB";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function errText(e) {
  if (!e) return "erro desconhecido";
  return e.message || String(e);
}

function setMsg(node, kind, html) {
  if (!kind) {
    node.hidden = true;
    node.innerHTML = "";
    return;
  }
  node.className = "msg msg-" + kind;
  node.innerHTML = html;
  node.hidden = false;
}

// ---------------------------------------------------------------- registo

const LOG_MAX_LINES = 2000;

function log(text, cls) {
  const t = new Date().toLocaleTimeString("pt-PT", { hour12: false });
  for (const part of String(text).split("\n")) {
    if (!part.trim()) continue;
    const line = document.createElement("div");
    if (cls) line.className = "l-" + cls;
    line.textContent = `[${t}] ${part}`;
    el.log.append(line);
  }
  while (el.log.childElementCount > LOG_MAX_LINES) el.log.firstElementChild.remove();
  el.log.scrollTop = el.log.scrollHeight;
}

// Terminal passado à esptool-js.
const espTerminal = {
  clean() {},
  writeLine(data) {
    log(data, "dim");
  },
  write(data) {
    log(data, "dim");
  },
};

// ---------------------------------------------------------------- estado / UI

function setBusy(b) {
  state.busy = b;
  document.body.classList.toggle("busy", b);
  el.btnConnect.disabled = b;
  el.btnDisconnect.disabled = b;
  el.baud.disabled = b || !!state.transport;
  el.fileInput.disabled = b;
  el.eraseAll.disabled = b;
  document.querySelectorAll('input[name="board"]').forEach((r) => (r.disabled = b));
  el.btnMonitor.disabled = b || !!state.monitor;
  updateChecks();
}

function selectedAddress() {
  if (el.addrMode.value === "manual") {
    const v = el.addrInput.value.trim();
    const n = /^0x[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : /^\d+$/.test(v) ? parseInt(v, 10) : NaN;
    return n;
  }
  return state.fw ? state.fw.info.address : 0;
}

/** Calcula a lista de verificações antes da gravação. */
function computeChecks() {
  const list = [];
  const ignore = el.ignoreChecks.checked;
  const soft = (text) => list.push({ level: ignore ? "warn" : "error", text: ignore ? text + " (ignorado)" : text });
  const fw = state.fw;
  const dev = state.device;
  const board = state.board === "auto" ? null : state.board;

  // Firmware
  if (!fw) {
    list.push({
      level: "pending",
      text: state.catalogMode ? "O firmware é descarregado depois de ligar a placa" : "Escolher o ficheiro .bin",
    });
  } else {
    for (const e of fw.info.errors) list.push({ level: ignore && fw.info.chip ? "warn" : "error", text: e });
    if (!fw.info.errors.length) {
      list.push({ level: "ok", text: `Firmware válido para ${fw.info.chip} (${fw.info.kind === "merged" ? "binário completo" : "só aplicação"})` });
    }
    for (const w of fw.info.warnings) list.push({ level: "warn", text: w });
    if (board && fw.info.chip && fw.info.chip !== board) {
      soft(`O firmware é para ${fw.info.chip}, mas escolheu a placa ${board}.`);
    }
    const addr = selectedAddress();
    if (Number.isNaN(addr) || addr < 0) {
      list.push({ level: "error", text: "Endereço manual inválido (use por exemplo 0x0 ou 0x10000)." });
    } else if (addr % 0x1000 !== 0) {
      list.push({ level: "error", text: `O endereço ${hex(addr)} tem de ser múltiplo de 0x1000.` });
    }
  }

  // Placa
  if (!dev) {
    list.push({ level: "pending", text: "Ligar à placa" });
  } else {
    list.push({ level: "ok", text: `Placa ligada: ${dev.description}` });
    if (board && dev.chip !== board) {
      soft(`A placa ligada é ${dev.chip}, mas escolheu ${board}. Verifique a placa ou mude a escolha no passo 1.`);
    }
    if (fw && fw.info.chip && fw.info.chip !== dev.chip) {
      soft(`O firmware é para ${fw.info.chip}, mas a placa ligada é ${dev.chip}.`);
    }
    if (fw && dev.flashSize) {
      const devBytes = flashSizeToBytes(dev.flashSize);
      const addr = selectedAddress();
      if (devBytes && addr + fw.bytes.length > devBytes) {
        list.push({
          level: "error",
          text: `O firmware (${fmtSize(fw.bytes.length)} a partir de ${hex(addr)}) não cabe na flash da placa (${dev.flashSize}).`,
        });
      } else if (devBytes && fw.info.flashSize && flashSizeToBytes(fw.info.flashSize) > devBytes) {
        soft(
          `O firmware foi compilado para flash de ${fw.info.flashSize}, mas a placa tem ${dev.flashSize}. ` +
            'No Arduino IDE ajuste "Flash Size" e o esquema de partições.'
        );
      }
    }
  }
  return list;
}

/** Indica se é possível manter as partições de dados (NVS, SPIFFS…) da placa. */
function keepDataStatus() {
  const fw = state.fw;
  const dev = state.device;
  if (!fw || fw.info.kind !== "merged") {
    return { available: false, reason: fw && fw.info.kind === "app" ? "Só a aplicação é gravada; os dados não são tocados." : "" };
  }
  if (state.release && state.release.manterDados === false) {
    return { available: false, reason: "Esta versão exige apagar os dados guardados." };
  }
  if (el.eraseAll.checked) return { available: false, reason: "Desativado porque vai apagar toda a flash." };
  if (el.addrMode.value === "manual" && selectedAddress() !== 0) return { available: false, reason: "" };
  if (!dev) return { available: false, reason: "Disponível depois de ligar a placa." };
  const devParts = dev.current && dev.current.partitions;
  if (!samePartitions(devParts, fw.info.partitions)) {
    return {
      available: false,
      reason: devParts
        ? "A placa tem uma tabela de partições diferente: vai ser feita uma instalação completa (os dados são apagados)."
        : "A placa não tem este firmware instalado: vai ser feita uma instalação completa.",
    };
  }
  const { kept } = buildSegments(fw.bytes, fw.info.partitions);
  if (!kept.length) return { available: false, reason: "Este firmware não tem partições de dados." };
  return { available: true, reason: "Partições mantidas: " + kept.map((p) => p.label).join(", ") + ".", kept };
}

function updateChecks() {
  const kd = keepDataStatus();
  el.keepData.disabled = state.busy || !kd.available;
  el.keepData.checked = kd.available && state.keepDataPref;
  el.keepDataNote.textContent = kd.reason || "";
  const list = computeChecks();
  el.checks.innerHTML = list.map((c) => `<li class="${c.level}">${escapeHtml(c.text)}</li>`).join("");
  const blocked = list.some((c) => c.level === "error" || c.level === "pending");
  el.btnFlash.disabled = state.busy || blocked || !state.loader;

  el.stepBoard.classList.toggle("done", !!state.fw || !!state.device);
  el.stepFirmware.classList.toggle("done", !!state.fw && state.fw.info.ok);
  el.stepConnect.classList.toggle("done", !!state.device);
  el.stepFlash.classList.toggle("done", state.flashed);
}

function setBoard(value, fromUser) {
  state.board = value;
  if (fromUser) state.boardTouched = true;
  const r = document.querySelector(`input[name="board"][value="${value}"]`);
  if (r) r.checked = true;
  updateChecks();
}

// ---------------------------------------------------------------- firmware

function setFirmware(fw) {
  fw.info = analyzeFirmware(fw.bytes);
  fw.md5 = md5(fw.bytes);
  state.fw = fw;
  state.flashed = false;
  setMsg(el.flashResult, null);
  el.progressWrap.hidden = true;

  log(`Firmware: ${fw.name} (${fmtSize(fw.bytes.length)}) — ${fw.info.kindLabel}, chip ${fw.info.chip ?? "?"}, MD5 ${fw.md5}`);
  fw.info.errors.forEach((e) => log(e, "err"));
  fw.info.warnings.forEach((w) => log(w, "warn"));

  // Se o utilizador não escolheu a placa, assume a do firmware.
  if (!state.boardTouched && state.board !== "auto" && fw.info.chip && ["ESP32", "ESP32-S3"].includes(fw.info.chip)) {
    setBoard(fw.info.chip, false);
  }
  if (el.addrMode.value === "manual") el.addrInput.value = hex(fw.info.address);
  renderFirmware();
  updateChecks();
}

function renderFirmware() {
  const fw = state.fw;
  if (!fw) {
    el.fwSummary.hidden = true;
    return;
  }
  const i = fw.info;
  let html = "";
  if (i.errors.length) {
    html += `<div class="msg msg-error"><b>Este ficheiro não pode ser usado:</b><ul>${i.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></div>`;
  }
  if (i.warnings.length) {
    html += `<div class="msg msg-warn"><ul>${i.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>`;
  }
  const rows = [
    ["Ficheiro", escapeHtml(fw.name)],
    ["Tamanho", fmtSize(fw.bytes.length)],
    ["Tipo", escapeHtml(i.kindLabel)],
    ["Chip", i.chip ? `<b>${escapeHtml(i.chip)}</b>` : "?"],
    ["Gravar em", `<code>${hex(i.address)}</code>`],
  ];
  if (i.flashSize) rows.push(["Flash (compilado)", `${escapeHtml(i.flashSize)} · ${escapeHtml(i.flashMode ?? "")}`]);
  if (i.app) {
    const name = i.app.project && i.app.project !== "arduino-lib-builder" ? i.app.project : null;
    if (name) rows.push(["Projeto", escapeHtml(name)]);
    if (i.app.version && name) rows.push(["Versão", escapeHtml(i.app.version)]);
    if (i.app.idf) rows.push(["ESP-IDF", escapeHtml(i.app.idf)]);
  }
  rows.push(["MD5", `<code>${fw.md5}</code>`]);
  html += `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;

  if (i.partitions) {
    html +=
      `<details class="parts-details"><summary>Tabela de partições (${i.partitions.length})</summary><div class="parts-wrap"><table class="parts">` +
      `<tr><th>Nome</th><th>Tipo</th><th>Subtipo</th><th>Início</th><th>Tamanho</th></tr>` +
      i.partitions
        .map(
          (p) =>
            `<tr><td>${escapeHtml(p.label)}</td><td>${p.type}</td><td>${p.subtype}</td><td><code>${hex(p.offset)}</code></td><td>${fmtSize(p.size)}</td></tr>`
        )
        .join("") +
      `</table></div></details>`;
  }
  el.fwSummary.innerHTML = html;
  el.fwSummary.hidden = false;
}

async function loadLocalFile(file) {
  if (!file || state.busy) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    setFirmware({ name: file.name, bytes, source: "local" });
  } catch (e) {
    log("Não foi possível ler o ficheiro: " + errText(e), "err");
  }
}

// ---------------------------------------------------------------- ligação

function explainConnectError(e) {
  const m = errText(e);
  if (/open|already open|NetworkError|InvalidStateError|Access denied|busy/i.test(m + " " + (e && e.name))) {
    return (
      "<b>A porta está ocupada ou não pôde ser aberta.</b><p>Feche o Arduino IDE / monitor série, outros programas de terminal " +
      "e outros separadores com esta página, e tente novamente.</p>"
    );
  }
  return (
    "<b>A placa não respondeu.</b><ul>" +
    "<li>Mantenha premido o botão <b>BOOT</b>, carregue e solte <b>RESET</b> (EN), solte <b>BOOT</b> e clique em <b>Ligar</b> outra vez.</li>" +
    "<li>No ESP32-S3 com USB nativo: mantenha <b>BOOT</b> premido enquanto liga o cabo.</li>" +
    "<li>Confirme que o cabo USB transmite dados e que escolheu a porta certa.</li></ul>" +
    `<p class="muted small">Detalhe: ${escapeHtml(m)}</p>`
  );
}

async function releaseTransport() {
  const t = state.transport;
  state.transport = null;
  state.loader = null;
  state.device = null;
  if (t) {
    try {
      await t.disconnect();
    } catch (e) {
      /* a porta pode já ter desaparecido (ex.: USB nativo após reset) */
    }
  }
  el.btnDisconnect.hidden = true;
  el.baud.disabled = false;
  renderDevice();
}

async function connect() {
  if (state.busy) return;
  if (!navigator.serial) return;
  await stopMonitor();
  await releaseTransport();

  let port;
  try {
    port = await navigator.serial.requestPort(el.allPorts.checked ? {} : { filters: USB_FILTERS });
  } catch (e) {
    if (e && e.name === "NotFoundError") {
      if (!el.allPorts.checked) {
        setMsg(
          el.connectMsg,
          "info",
          'Nenhuma porta escolhida. Se a porta da placa não aparecer na lista, ative <i>Mostrar todas as portas série</i> em <i>Opções avançadas</i> ou veja <i>Problemas comuns</i> no fim da página.'
        );
      }
      return;
    }
    setMsg(el.connectMsg, "error", escapeHtml(errText(e)));
    return;
  }

  setBusy(true);
  setMsg(el.connectMsg, "info", "A ligar à placa e a entrar em modo de programação…");
  setMsg(el.flashResult, null);
  el.progressWrap.hidden = true;
  state.flashed = false;
  state.port = port;
  const info = port.getInfo ? port.getInfo() : {};
  log(`Porta escolhida (USB VID ${hex(info.usbVendorId ?? 0)} PID ${hex(info.usbProductId ?? 0)}). A ligar…`);

  const transport = new Transport(port, false);
  try {
    const loader = new ESPLoader({
      transport,
      baudrate: parseInt(el.baud.value, 10),
      terminal: espTerminal,
      debugLogging: false,
    });
    const description = await loader.main();
    state.transport = transport;
    state.loader = loader;

    const chip = loader.chip.CHIP_NAME;
    const dev = { chip, description, mac: null, flashSize: null, features: null, current: null };
    try {
      dev.mac = await loader.chip.readMac(loader);
    } catch (e) {
      /* opcional */
    }
    try {
      dev.features = await loader.chip.getChipFeatures(loader);
    } catch (e) {
      /* opcional */
    }
    try {
      dev.flashSize = (await loader.detectFlashSize()) ?? null;
    } catch (e) {
      log("Não foi possível detetar o tamanho da flash: " + errText(e), "warn");
    }
    dev.current = await readCurrentFirmware(loader);
    state.device = dev;

    log(`Ligado: ${description}${dev.flashSize ? ", flash " + dev.flashSize : ""}`, "ok");
    setMsg(el.connectMsg, null);
    el.btnDisconnect.hidden = false;

    if (state.board === "auto" && !state.boardTouched) {
      /* mantém automático */
    }
    renderDevice();

    if (state.catalogMode) await loadCatalogBuild(chip);
  } catch (e) {
    log("Falha na ligação: " + errText(e), "err");
    setMsg(el.connectMsg, "error", explainConnectError(e));
    state.transport = transport;
    await releaseTransport();
  } finally {
    setBusy(false);
  }
}

/** Lê (sem alterar nada) a aplicação que está gravada na placa. */
async function readCurrentFirmware(loader) {
  try {
    const pt = await loader.readFlash(0x8000, 0xc00);
    const parts = readPartitionTable(pt, 0);
    if (!parts) return { empty: true, partitions: null };
    const app =
      parts.find((p) => p.type === "app" && p.subtype === "factory") ||
      parts.find((p) => p.type === "app" && p.subtype === "ota_0") ||
      parts.find((p) => p.type === "app");
    if (!app) return { partitions: parts };
    const head = await loader.readFlash(app.offset, 512);
    const desc = readAppDesc(head, 0);
    return desc ? { ...desc, partition: app.label, partitions: parts } : { empty: head[0] === 0xff, partitions: parts };
  } catch (e) {
    log("Não foi possível ler o firmware atual da placa: " + errText(e), "dim");
    return null;
  }
}

function renderDevice() {
  const d = state.device;
  if (!d) {
    el.deviceInfo.hidden = true;
    el.deviceInfo.innerHTML = "";
    updateChecks();
    return;
  }
  const rows = [
    ["Chip", `<b>${escapeHtml(d.description)}</b>`],
    ["Flash", d.flashSize ? escapeHtml(d.flashSize) : "não detetado"],
  ];
  if (d.features) rows.push(["Características", escapeHtml(Array.isArray(d.features) ? d.features.join(", ") : d.features)]);
  if (d.mac) rows.push(["MAC", `<code>${escapeHtml(d.mac)}</code>`]);
  if (d.current) {
    if (d.current.empty) rows.push(["Firmware atual", "nenhum (flash vazia)"]);
    else if (d.current.project !== undefined) {
      const name = d.current.project && d.current.project !== "arduino-lib-builder" ? d.current.project : "aplicação";
      const ver = d.current.project !== "arduino-lib-builder" && d.current.version ? " v" + d.current.version : "";
      rows.push(["Firmware atual", `${escapeHtml(name + ver)} <span class="muted small">(partição ${escapeHtml(d.current.partition)})</span>`]);
    }
  }
  el.deviceInfo.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  el.deviceInfo.hidden = false;
  updateChecks();
}

async function disconnect() {
  if (state.busy) return;
  await releaseTransport();
  log("Desligado.");
}

// ---------------------------------------------------------------- gravação

function setProgress(fraction, text, mode) {
  el.progressWrap.hidden = false;
  el.progressBar.classList.remove("indeterminate", "ok", "error");
  if (mode) el.progressBar.classList.add(mode);
  if (mode === "indeterminate") {
    el.progressBar.style.width = "";
    el.progressPct.textContent = "";
  } else {
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    el.progressBar.style.width = pct + "%";
    el.progressPct.textContent = pct + "%";
  }
  el.progressText.textContent = text;
}

function explainFlashError(e) {
  const m = errText(e);
  if (/MD5/i.test(m)) {
    return (
      "<b>A verificação falhou:</b> o conteúdo gravado não corresponde ao ficheiro." +
      "<p>Ligue de novo, escolha a velocidade <b>115200</b>, ative <i>Apagar toda a flash antes de gravar</i> e repita.</p>"
    );
  }
  return (
    "<b>A gravação foi interrompida.</b><ul>" +
    "<li>Não desligue o cabo durante a gravação; evite hubs USB.</li>" +
    "<li>Clique em <b>Ligar</b> outra vez, escolha a velocidade <b>115200</b> e repita.</li></ul>" +
    `<p class="muted small">Detalhe: ${escapeHtml(m)}</p>`
  );
}

async function flash() {
  if (state.busy || !state.loader || !state.fw) return;
  const list = computeChecks();
  if (list.some((c) => c.level === "error" || c.level === "pending")) return;

  const fw = state.fw;
  const address = selectedAddress();
  const erase = el.eraseAll.checked;
  const kd = keepDataStatus();
  const keep = kd.available && el.keepData.checked;
  const fileArray = keep ? buildSegments(fw.bytes, fw.info.partitions).segments : [{ data: fw.bytes, address }];
  const totalBytes = fileArray.reduce((n, f) => n + f.data.length, 0);
  const before = [];
  fileArray.reduce((n, f, i) => ((before[i] = n), n + f.data.length), 0);
  setBusy(true);
  setMsg(el.flashResult, null);
  state.flashed = false;
  const t0 = performance.now();
  log(`A gravar ${fw.name} em ${hex(address)}${erase ? " (com apagamento total)" : ""}…`);
  if (keep) log(`A manter os dados da placa (${kd.kept.map((p) => p.label).join(", ")}); ${fileArray.length} blocos a gravar.`);

  let verifying = false;
  try {
    if (erase) setProgress(0, "A apagar a flash… (pode demorar até 1 minuto)", "indeterminate");
    else setProgress(0, "A preparar…");

    await state.loader.writeFlash({
      fileArray,
      flashSize: "keep",
      flashMode: "keep",
      flashFreq: "keep",
      eraseAll: erase,
      compress: true,
      reportProgress: (i, written, total) => {
        const done = before[i] + Math.min(written, total);
        if (written >= total) {
          verifying = i === fileArray.length - 1;
          setProgress(done / totalBytes, "A verificar o que foi gravado (MD5)…", verifying ? "indeterminate" : undefined);
        } else {
          setProgress(done / totalBytes, `A gravar… ${fmtSize(done)} de ${fmtSize(totalBytes)}`);
        }
      },
      calculateMD5Hash: (image) => md5(image),
    });

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setProgress(1, `Gravado e verificado em ${secs} s`, "ok");
    log(`Gravado e verificado (MD5 ${fw.md5}) em ${secs} s.`, "ok");

    try {
      await state.loader.after("hard_reset");
      log("Placa reiniciada.", "ok");
    } catch (e) {
      log("Não foi possível reiniciar automaticamente: " + errText(e), "warn");
    }
    await releaseTransport();
    state.flashed = true;

    const what =
      state.catalogMode && state.product
        ? `<b>${escapeHtml(state.product.nome)} v${escapeHtml(state.release.versao)}</b> instalado`
        : "<b>Firmware gravado</b>";
    setMsg(
      el.flashResult,
      "ok",
      `✔ ${what} e verificado com sucesso. A placa foi reiniciada.` +
        "<p>Pode desligar o cabo USB. Se a placa não arrancar sozinha, carregue no botão <b>RESET</b>. " +
        "Para ver as mensagens da placa, use o <b>Monitor série</b> abaixo.</p>"
    );
  } catch (e) {
    log("Erro na gravação: " + errText(e), "err");
    setProgress(verifying ? 1 : 0, verifying ? "Falhou a verificação" : "Falhou", "error");
    setMsg(el.flashResult, "error", explainFlashError(e));
    await releaseTransport();
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------- monitor série

const MONITOR_MAX_CHARS = 200000;

function monitorWrite(text) {
  const out = el.monitorOut;
  const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 20;
  let s = out.textContent + text.replace(/\r\n?/g, "\n");
  if (s.length > MONITOR_MAX_CHARS) s = s.slice(s.length - MONITOR_MAX_CHARS);
  out.textContent = s;
  if (atBottom) out.scrollTop = out.scrollHeight;
}

async function openMonitor() {
  if (state.busy || state.monitor) return;
  if (state.transport) await releaseTransport();

  const baud = parseInt(el.monitorBaud.value, 10);
  let port = state.port;
  const tryOpen = async (p) => {
    await p.open({ baudRate: baud });
    return p;
  };
  try {
    if (!port) throw new Error("sem porta");
    await tryOpen(port);
  } catch (e) {
    // A porta pode ter mudado (ex.: ESP32-S3 com USB nativo depois de reiniciar).
    try {
      port = await navigator.serial.requestPort(el.allPorts.checked ? {} : { filters: USB_FILTERS });
      await tryOpen(port);
    } catch (e2) {
      if (e2 && e2.name !== "NotFoundError") {
        monitorWrite(`\n[não foi possível abrir a porta: ${errText(e2)}]\n`);
      }
      return;
    }
  }
  state.port = port;
  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  } catch (e) {
    /* nem todos os adaptadores suportam */
  }

  const mon = { port, reader: null, stopping: false, done: null };
  state.monitor = mon;
  el.btnMonitor.disabled = true;
  el.btnMonitorStop.disabled = false;
  el.btnReset.disabled = false;
  el.btnConnect.disabled = false;
  monitorWrite(`\n--- monitor aberto a ${baud} baud ---\n`);

  mon.done = (async () => {
    const decoder = new TextDecoder();
    while (port.readable && !mon.stopping) {
      const reader = port.readable.getReader();
      mon.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) monitorWrite(decoder.decode(value, { stream: true }));
        }
      } catch (e) {
        if (!mon.stopping) monitorWrite(`\n[ligação perdida: ${errText(e)}]\n`);
        break;
      } finally {
        reader.releaseLock();
      }
    }
  })();
}

async function stopMonitor() {
  const mon = state.monitor;
  if (!mon) return;
  mon.stopping = true;
  try {
    if (mon.reader) await mon.reader.cancel();
  } catch (e) {
    /* ignora */
  }
  try {
    await mon.done;
  } catch (e) {
    /* ignora */
  }
  try {
    await mon.port.close();
  } catch (e) {
    /* ignora */
  }
  state.monitor = null;
  el.btnMonitor.disabled = state.busy;
  el.btnMonitorStop.disabled = true;
  el.btnReset.disabled = true;
  monitorWrite("\n--- monitor fechado ---\n");
}

async function resetBoard() {
  const mon = state.monitor;
  if (!mon) return;
  try {
    // EN em baixo (RTS) com IO0 em alto (DTR) -> arranque normal.
    await mon.port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(120);
    await mon.port.setSignals({ dataTerminalReady: false, requestToSend: false });
  } catch (e) {
    monitorWrite(`\n[não foi possível reiniciar: ${errText(e)}]\n`);
  }
}

// ---------------------------------------------------------------- catálogo de firmwares
//
// Público:  ?produto=<id>                       → docs/firmware/catalog.json
// Cliente:  ?c=<cliente>&produto=<id>#k=<chave>  → docs/firmware/clientes/<cliente>/catalogo.enc (cifrado)
// A chave vai depois do "#": o browser nunca a envia ao servidor.

const CATALOG_URL = "firmware/catalog.json";

function catalogFileUrl(path) {
  return new URL(path, new URL("firmware/", location.href)).href;
}

function productLink(id) {
  const u = new URL(location.href);
  const q = new URLSearchParams();
  if (state.client) q.set("c", state.client.id);
  q.set("produto", id);
  u.search = "?" + q.toString();
  u.hash = state.client ? "k=" + state.client.key : "";
  return u.href;
}

/** Descarrega um ficheiro (Uint8Array), com progresso opcional. */
async function fetchBytes(url, onProgress) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  const total = parseInt(r.headers.get("content-length") || "0", 10);
  const chunks = [];
  let got = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onProgress && total) onProgress(got / total);
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return bytes;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Bloqueia a página (só mostra o pedido de código ou a lista de firmwares do cliente). */
function lockPage(locked) {
  document.body.classList.toggle("locked", locked);
}

function showAccessForm(errorHtml) {
  lockPage(true);
  el.accessCard.hidden = false;
  setMsg(el.accessMsg, errorHtml ? "error" : null, errorHtml || "");
  el.accessCode.focus();
}

/** Abre o catálogo cifrado de um cliente. Devolve null (e mostra a mensagem) se não for possível. */
async function openClientCatalog(cid) {
  if (!/^[a-z0-9-]{3,40}$/.test(cid)) {
    showAccessForm("Este link não é válido. Confirme que o copiou completo.");
    el.accessForm.hidden = true;
    return null;
  }
  const key = new URLSearchParams(location.hash.slice(1)).get("k");
  if (!key) {
    showAccessForm(null);
    return null;
  }
  if (!chaveValida(key)) {
    showAccessForm("O código de acesso não está completo ou tem um erro. Confirme que o copiou todo (43 caracteres).");
    return null;
  }
  let blob;
  try {
    blob = await fetchBytes(`firmware/clientes/${cid}/catalogo.enc`);
  } catch (e) {
    lockPage(true);
    el.accessCard.hidden = false;
    el.accessForm.hidden = true;
    setMsg(
      el.accessMsg,
      "error",
      e.status === 404
        ? "<b>Este link já não é válido ou o acesso foi removido.</b><p>Contacte quem lhe enviou o link.</p>"
        : `<b>Não foi possível abrir a lista de firmwares.</b> Verifique a ligação à Internet e recarregue a página.<p class="muted small">Detalhe: ${escapeHtml(errText(e))}</p>`
    );
    return null;
  }
  try {
    const catalog = await decifrarJSON(key, blob, contextoCatalogo(cid));
    state.client = { id: cid, key, nome: catalog.cliente || "" };
    log(`Acesso de cliente aberto${state.client.nome ? ": " + state.client.nome : ""}.`, "ok");
    return catalog;
  } catch (e) {
    showAccessForm(
      e.chaveErrada
        ? "<b>Código de acesso errado.</b> Confirme o código ou use o link exatamente como o recebeu."
        : escapeHtml(errText(e))
    );
    return null;
  }
}

async function initCatalog() {
  const params = new URLSearchParams(location.search);
  let pid = params.get("produto") || params.get("p");
  const cid = params.get("c");
  let catalog = null;

  if (cid) {
    catalog = await openClientCatalog(cid);
    if (!catalog) return;
  } else {
    try {
      const r = await fetch(CATALOG_URL, { cache: "no-cache" });
      if (r.ok) catalog = await r.json();
    } catch (e) {
      /* sem catálogo (ex.: página aberta localmente) */
    }
  }

  const products = ((catalog && catalog.produtos) || []).filter((p) => p.versoes && p.versoes.length);
  if (!pid) {
    if (cid && products.length === 1) {
      pid = products[0].id;
    } else {
      if (cid) {
        lockPage(true);
        el.productsTitle.textContent = state.client.nome ? `Firmwares de ${state.client.nome}` : "Os seus firmwares";
        el.productsIntro.textContent = products.length
          ? "Escolha o firmware a instalar."
          : "Ainda não há firmwares disponíveis para si.";
        el.productsCard.hidden = false;
      }
      if (products.length) renderProductList(products);
      return;
    }
  }
  const product = products.find((p) => p.id === pid);
  if (!product) {
    setMsg(el.connectMsg, "error", `O produto <b>${escapeHtml(pid)}</b> não foi encontrado no catálogo de firmwares.`);
    return;
  }
  const wanted = params.get("versao") || params.get("v");
  const release = wanted ? product.versoes.find((v) => v.versao === wanted) : product.versoes[0];
  if (!release) {
    setMsg(el.connectMsg, "error", `A versão <b>${escapeHtml(wanted)}</b> de ${escapeHtml(product.nome)} não existe.`);
    return;
  }
  enterCatalogMode(product, release);
}

function enterCatalogMode(product, release) {
  state.catalogMode = true;
  state.product = product;
  state.release = release;
  document.title = `${product.nome} · ESP32 Flash via WEB`;

  el.pbEyebrow.textContent =
    "Atualização de firmware" + (state.client && state.client.nome ? " · " + state.client.nome : "");
  el.pbName.textContent = product.nome;
  el.pbDesc.textContent = product.descricao || "";
  el.pbVersion.textContent = "v" + release.versao;
  el.pbDate.textContent = release.data || "";
  if (release.notas) {
    el.pbNotes.textContent = release.notas;
    el.pbNotes.hidden = false;
  }
  el.productBanner.hidden = false;

  // O chip é detetado ao ligar: o passo "placa" deixa de ser necessário.
  setBoard("auto", false);
  el.stepBoard.hidden = true;
  el.localFw.hidden = true;
  el.catalogFw.hidden = false;
  const chips = Object.keys(release.ficheiros || {});
  el.catalogFwText.innerHTML =
    `Disponível para: ${chips.map((c) => `<span class="tag">${escapeHtml(c)}</span>`).join(" ")}<br>` +
    `<span class="muted">O firmware certo para a sua placa é descarregado automaticamente depois de ligar.</span>`;
  // Primeiro ligar, depois firmware.
  el.stepConnect.after(el.stepFirmware);
  el.stepFirmware.after(el.stepFlash);
  el.btnFlashText.textContent = `Instalar ${product.nome} v${release.versao}`;
  updateChecks();
}

async function loadCatalogBuild(chip) {
  const entry = (state.release.ficheiros || {})[chip];
  if (!entry) {
    const avail = Object.keys(state.release.ficheiros || {}).join(", ");
    setMsg(
      el.connectMsg,
      "error",
      `<b>${escapeHtml(state.product.nome)}</b> não tem firmware para <b>${escapeHtml(chip)}</b>. Disponível para: ${escapeHtml(avail)}.`
    );
    return;
  }
  const file = typeof entry === "string" ? { ficheiro: entry } : entry;
  const encrypted = /\.enc$/.test(file.ficheiro);
  const name = file.ficheiro.split("/").pop().replace(/\.enc$/, "");
  log(`A descarregar ${name}…`);
  el.catalogFwText.innerHTML = `A descarregar <b>${escapeHtml(name)}</b>…`;
  try {
    let bytes = await fetchBytes(catalogFileUrl(file.ficheiro), (f) => {
      el.catalogFwText.innerHTML = `A descarregar <b>${escapeHtml(name)}</b>… ${Math.min(100, Math.round(f * 100))}%`;
    });
    if (encrypted) {
      if (!state.client) throw new Error("firmware protegido: falta o código de acesso");
      bytes = await decifrar(state.client.key, bytes, contextoFicheiro(file.ficheiro));
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
      log("Firmware decifrado.", "ok");
    }
    if (file.tamanho && bytes.length !== file.tamanho) {
      throw new Error(`tamanho inesperado (${bytes.length} em vez de ${file.tamanho} bytes)`);
    }
    if (file.md5) {
      const h = md5(bytes);
      if (h !== file.md5.toLowerCase()) throw new Error(`o MD5 do ficheiro descarregado não confere (${h})`);
    }
    el.catalogFwText.innerHTML = `Firmware para <b>${escapeHtml(chip)}</b> descarregado e confirmado.`;
    setFirmware({ name, bytes, source: "catalog" });
  } catch (e) {
    log("Falha a descarregar o firmware: " + errText(e), "err");
    el.catalogFwText.innerHTML = "";
    setMsg(
      el.connectMsg,
      "error",
      `<b>Não foi possível descarregar o firmware.</b> Verifique a ligação à Internet e tente <b>Ligar</b> novamente.<p class="muted small">Detalhe: ${escapeHtml(errText(e))}</p>`
    );
  }
}

function renderProductList(products) {
  const forClient = !!state.client;
  el.productList.innerHTML = products
    .map((p) => {
      const v = p.versoes[0];
      const chips = Object.keys(v.ficheiros || {});
      const href = escapeHtml(productLink(p.id));
      return (
        `<div class="product-item"><div><h3>${escapeHtml(p.nome)} <span class="muted small">v${escapeHtml(v.versao)}${v.data ? " · " + escapeHtml(v.data) : ""}</span></h3>` +
        (p.descricao ? `<p class="muted small">${escapeHtml(p.descricao)}</p>` : "") +
        `<p>${chips.map((c) => `<span class="tag">${escapeHtml(c)}</span>`).join("")}</p></div>` +
        `<div class="row tight"><a class="btn btn-sm btn-primary" href="${href}">${forClient ? "Instalar" : "Abrir instalador"}</a>` +
        (forClient ? "" : `<button class="btn btn-sm" type="button" data-copy="${href}">Copiar link</button>`) +
        `</div></div>`
      );
    })
    .join("");
  el.productsCard.hidden = false;
}

// ---------------------------------------------------------------- arranque

function bindEvents() {
  document.querySelectorAll('input[name="board"]').forEach((r) =>
    r.addEventListener("change", () => setBoard(r.value, true))
  );

  el.fileInput.addEventListener("change", () => loadLocalFile(el.fileInput.files[0]));
  ["dragenter", "dragover"].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.remove("drag");
    })
  );
  el.dropzone.addEventListener("drop", (e) => loadLocalFile(e.dataTransfer.files[0]));

  el.accessForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = el.accessCode.value.replace(/\s+/g, "");
    if (!chaveValida(code)) {
      setMsg(el.accessMsg, "error", "O código deve ter 43 caracteres (letras, números, - e _). Confirme que o copiou todo.");
      return;
    }
    location.hash = "k=" + code;
    location.reload();
  });
  el.btnConnect.addEventListener("click", connect);
  el.btnDisconnect.addEventListener("click", disconnect);
  el.btnFlash.addEventListener("click", flash);

  el.addrMode.addEventListener("change", () => {
    el.addrInput.disabled = el.addrMode.value !== "manual";
    if (el.addrMode.value === "manual" && state.fw) el.addrInput.value = hex(state.fw.info.address);
    updateChecks();
  });
  el.addrInput.addEventListener("input", updateChecks);
  el.ignoreChecks.addEventListener("change", updateChecks);
  el.eraseAll.addEventListener("change", updateChecks);
  el.keepData.addEventListener("change", () => {
    state.keepDataPref = el.keepData.checked;
    updateChecks();
  });

  el.btnMonitor.addEventListener("click", openMonitor);
  el.btnMonitorStop.addEventListener("click", stopMonitor);
  el.btnReset.addEventListener("click", resetBoard);

  el.btnCopyLog.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(el.log.innerText);
      el.btnCopyLog.textContent = "Copiado!";
      setTimeout(() => (el.btnCopyLog.textContent = "Copiar"), 1500);
    } catch (e) {
      /* ignora */
    }
  });
  el.btnClearLog.addEventListener("click", () => (el.log.innerHTML = ""));

  el.productList.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      b.textContent = "Copiado!";
      setTimeout(() => (b.textContent = "Copiar link"), 1500);
    } catch (err) {
      prompt("Copie o link:", b.dataset.copy);
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (state.busy) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  if (navigator.serial) {
    navigator.serial.addEventListener("disconnect", (e) => {
      if (e.target === state.port || e.port === state.port) {
        if (state.transport && !state.busy) {
          log("A placa foi desligada.", "warn");
          releaseTransport();
        }
      }
    });
  }
}

function init() {
  if (!("serial" in navigator) || !window.isSecureContext) {
    el.unsupported.hidden = false;
    el.btnConnect.disabled = true;
    el.btnMonitor.disabled = true;
  }
  bindEvents();
  updateChecks();
  log("ESP32 Flash via WEB — by Jorge Pinheiro. Pronto.");
  initCatalog();
}

init();
