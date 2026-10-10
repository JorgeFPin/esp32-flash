#!/usr/bin/env node
// Gestão de clientes com firmware protegido (cifrado) no "ESP32 Flash via WEB".
//
//   node tools/clientes.mjs novo --nome "Hotel Sol"          cria o cliente e a chave
//   node tools/clientes.mjs lista                            lista clientes, produtos e versões
//   node tools/clientes.mjs link --cliente "Hotel Sol" [--produto termostato] [--sem-chave]
//   node tools/clientes.mjs nova-chave --cliente "Hotel Sol" troca a chave (o link antigo deixa de funcionar)
//   node tools/clientes.mjs remover-versao --cliente "Hotel Sol" --produto termostato --versao 1.0.0
//   node tools/clientes.mjs remover --cliente "Hotel Sol" --confirmar
//
// As chaves ficam em segredos/clientes.json (fora do GitHub). Ver MANUAL.md.

import fs from "node:fs";
import path from "node:path";
import {
  ROOT,
  SECRETS_FILE,
  parseArgs,
  fail,
  loadSecrets,
  saveSecrets,
  findClient,
  newClientId,
  novaChave,
  readClientCatalog,
  writeClientCatalog,
  clientDir,
  FW_DIR,
  encryptFile,
  decryptFile,
  link,
  assertSecretsNotTracked,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2), ["confirmar", "sem-chave"]);
const cmd = args._[0];
const secretsRel = path.relative(ROOT, SECRETS_FILE);

function help() {
  console.log(`Utilização:
  node tools/clientes.mjs novo --nome "<nome do cliente>"
  node tools/clientes.mjs lista
  node tools/clientes.mjs link --cliente "<nome ou id>" [--produto <id>] [--sem-chave]
  node tools/clientes.mjs nova-chave --cliente "<nome ou id>"
  node tools/clientes.mjs remover-versao --cliente "<nome ou id>" --produto <id> --versao <x.y.z>
  node tools/clientes.mjs remover --cliente "<nome ou id>" --confirmar`);
  process.exit(cmd ? 1 : 0);
}

if (!cmd || cmd === "ajuda" || cmd === "help") help();
assertSecretsNotTracked();
const secrets = loadSecrets();

if (cmd === "novo") {
  const nome = (args.nome || "").trim();
  if (!nome) fail('indique o nome: --nome "Nome do cliente"');
  if (secrets.clientes.some((c) => c.nome.toLowerCase() === nome.toLowerCase())) fail(`já existe um cliente "${nome}"`);
  const client = { id: newClientId(secrets), nome, chave: await novaChave(), criado: new Date().toISOString().slice(0, 10) };
  secrets.clientes.push(client);
  saveSecrets(secrets);
  await writeClientCatalog(client, { produtos: [] });
  console.log(`✓ Cliente "${nome}" criado.`);
  console.log(`  ID: ${client.id}   (pasta docs/firmware/clientes/${client.id}/)`);
  console.log(`  Chave guardada em ${secretsRel} — faça já uma cópia de segurança (ver MANUAL.md).`);
  console.log(`\n  Próximo passo: publicar um firmware para este cliente, por exemplo:`);
  console.log(`  node tools/publicar-firmware.mjs --cliente "${nome}" --produto <id> --nome "<Nome>" --versao 1.0.0 --esp32 <ficheiro.merged.bin>`);
} else if (cmd === "lista") {
  if (!secrets.clientes.length) {
    console.log(`Ainda não há clientes (${secretsRel}). Crie um com: node tools/clientes.mjs novo --nome "Nome"`);
  }
  for (const c of secrets.clientes) {
    const cat = await readClientCatalog(c);
    console.log(`\n■ ${c.nome}  [id ${c.id}, criado ${c.criado}]`);
    if (!cat.produtos.length) console.log("    (sem firmwares publicados)");
    for (const p of cat.produtos) {
      const vs = p.versoes.map((v) => `v${v.versao} (${Object.keys(v.ficheiros).join(", ")})`).join(", ");
      console.log(`    - ${p.nome} [${p.id}]: ${vs}`);
    }
    console.log(`    Link: ${link({ cliente: c.id, chave: c.chave })}`);
  }
} else if (cmd === "link") {
  const c = findClient(secrets, args.cliente);
  if (args.produto) {
    const cat = await readClientCatalog(c);
    if (!cat.produtos.some((p) => p.id === args.produto)) {
      fail(`o cliente "${c.nome}" não tem o produto "${args.produto}". Produtos: ${cat.produtos.map((p) => p.id).join(", ") || "nenhum"}`);
    }
  }
  if (args["sem-chave"]) {
    console.log(`Link (sem chave):  ${link({ cliente: c.id, produto: args.produto })}`);
    console.log(`Código de acesso:  ${c.chave}`);
    console.log("\nEnvie o link e o código por canais diferentes (ex.: link por email, código por SMS/WhatsApp).");
  } else {
    console.log(link({ cliente: c.id, produto: args.produto, chave: c.chave }));
  }
} else if (cmd === "nova-chave") {
  const c = findClient(secrets, args.cliente);
  const cat = await readClientCatalog(c);
  const newKey = await novaChave();
  // 1) Cifra tudo de novo em memória (nada é alterado se algum ficheiro falhar).
  const rewrites = [];
  for (const p of cat.produtos) {
    for (const v of p.versoes) {
      for (const f of Object.values(v.ficheiros)) {
        const abs = path.join(FW_DIR, ...f.ficheiro.split("/"));
        if (!fs.existsSync(abs)) fail(`ficheiro em falta: docs/firmware/${f.ficheiro}`);
        const plain = await decryptFile(c.chave, f.ficheiro, new Uint8Array(fs.readFileSync(abs)));
        rewrites.push({ abs, data: await encryptFile(newKey, f.ficheiro, plain) });
      }
    }
  }
  // 2) Guarda primeiro a chave nova (a antiga fica no histórico), 3) depois os ficheiros.
  c.chavesAntigas = [...(c.chavesAntigas || []), { chave: c.chave, ate: new Date().toISOString().slice(0, 10) }];
  c.chave = newKey;
  saveSecrets(secrets);
  for (const r of rewrites) fs.writeFileSync(r.abs, r.data);
  await writeClientCatalog(c, cat, newKey);
  console.log(`✓ Nova chave para "${c.nome}" (${rewrites.length} ficheiro(s) cifrados de novo).`);
  console.log(`  O link antigo deixa de funcionar depois do push. Novo link:`);
  console.log(`  ${link({ cliente: c.id, chave: c.chave })}`);
  console.log(`\n  Falta: git add docs/firmware && git commit -m "Nova chave ${c.nome}" && git push`);
} else if (cmd === "remover-versao") {
  const c = findClient(secrets, args.cliente);
  const cat = await readClientCatalog(c);
  const p = cat.produtos.find((x) => x.id === args.produto);
  if (!p) fail(`produto "${args.produto}" não encontrado`);
  const i = p.versoes.findIndex((v) => v.versao === args.versao);
  if (i < 0) fail(`versão "${args.versao}" não encontrada em ${p.id}`);
  const [v] = p.versoes.splice(i, 1);
  for (const f of Object.values(v.ficheiros)) fs.rmSync(path.join(FW_DIR, ...f.ficheiro.split("/")), { force: true });
  fs.rmSync(path.join(clientDir(c), p.id, v.versao), { recursive: true, force: true });
  if (!p.versoes.length) {
    cat.produtos = cat.produtos.filter((x) => x !== p);
    fs.rmSync(path.join(clientDir(c), p.id), { recursive: true, force: true });
  }
  await writeClientCatalog(c, cat);
  console.log(`✓ Removida a versão ${v.versao} de ${p.nome} (cliente "${c.nome}").`);
  console.log(`  Falta: git add -A docs/firmware && git commit -m "Remove ${p.id} ${v.versao}" && git push`);
} else if (cmd === "remover") {
  const c = findClient(secrets, args.cliente);
  if (!args.confirmar) fail(`isto apaga todos os firmwares de "${c.nome}". Repita com --confirmar`);
  fs.rmSync(clientDir(c), { recursive: true, force: true });
  secrets.clientes = secrets.clientes.filter((x) => x !== c);
  secrets.removidos = [...(secrets.removidos || []), { ...c, removido: new Date().toISOString().slice(0, 10) }];
  saveSecrets(secrets);
  console.log(`✓ Cliente "${c.nome}" removido. O link deixa de funcionar depois do push.`);
  console.log(`  Falta: git add -A docs/firmware && git commit -m "Remove cliente ${c.nome}" && git push`);
} else {
  console.error(`Comando desconhecido: ${cmd}\n`);
  help();
}
