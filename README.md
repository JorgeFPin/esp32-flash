# ESP32 Flash via WEB — by Jorge Pinheiro

Página web para gravar firmware (`.bin`) em **ESP32** e **ESP32-S3** diretamente no browser, sem
instalar nada no PC do cliente. Grava, **verifica (MD5)** e reinicia a placa.

- Código da página: [`docs/`](docs/) (HTML + JavaScript, sem servidor; usa a
  [esptool-js](https://github.com/espressif/esptool-js) oficial da Espressif, incluída em `docs/vendor/`).
- Funciona no **Google Chrome** e no **Microsoft Edge** em computador (Windows, macOS, Linux).
  Firefox, Safari e telemóveis não têm acesso à porta série.

### Duas formas de usar

**1. Enviar o `.bin` ao cliente**
O cliente abre o link da página, escolhe a placa (ESP32 / ESP32-S3), escolhe o ficheiro `.bin`,
clica em **Ligar** (escolhe a porta COM) e depois em **Gravar e verificar**.

**2. Link por produto (o cliente só escolhe a porta COM)**
`https://jorgefpin.github.io/esp32-flash/?produto=<id>`: a página mostra o produto e a última versão, deteta o chip quando o
cliente liga a placa, descarrega o `.bin` certo (ESP32 ou ESP32-S3), confirma o MD5 e instala.
Numa atualização, as definições guardadas (Wi-Fi/NVS, SPIFFS/LittleFS) são **mantidas**
automaticamente quando a tabela de partições é a mesma.

Outras opções do link: `&versao=1.0.0` (uma versão específica).

Exemplo incluído: produto `demo` → `?produto=demo` (firmware de teste que pisca o LED e escreve no
monitor série a 115200; código em [`exemplos/demo-flash-web/`](exemplos/demo-flash-web/)).

### Proteções contra erros

- Analisa o `.bin` antes de gravar: identifica o chip a que se destina, se é o ficheiro completo
  (`merged`) ou só a aplicação, a tabela de partições e o tamanho de flash.
- Rejeita ficheiros que não são firmware ESP32, ou que são só o bootloader ou só as partições.
- Bloqueia a gravação se o chip do firmware, a placa escolhida e a placa ligada não coincidirem,
  ou se o firmware não couber na flash da placa.
- Verifica por MD5 o que ficou gravado na flash e reinicia a placa no fim.
- Mensagens de ajuda para os problemas mais comuns (porta ocupada, botão BOOT, drivers CH340/CP210x).

### Gerar o `.bin` no Arduino IDE

**Sketch → Exportar binário compilado** (core ESP32 3.x). Na pasta `build/…` do sketch fica o
`<sketch>.ino.merged.bin`: é esse o ficheiro a enviar ou publicar (bootloader + partições + app,
gravado em `0x0`).

### Publicar uma nova versão no catálogo (link por produto)

Com o Node.js 18+ instalado:

```bash
node tools/publicar-firmware.mjs --produto intelitherm --nome "InteliTherm" --versao 1.0.0 \
     --notas "Primeira versão" \
     --esp32 caminho/para/sketch.ino.merged.bin \
     --esp32s3 caminho/para/sketch_s3.ino.merged.bin
git add docs/firmware && git commit -m "InteliTherm v1.0.0" && git push
```

O script valida cada ficheiro (chip certo, binário completo), copia-o para
`docs/firmware/<produto>/<versao>/` e põe a versão no topo de `docs/firmware/catalog.json`
(a primeira da lista é a "última versão" que o link instala). Para uma versão que obrigue a apagar
as definições guardadas, use `--manter-dados nao`.

Sem Node.js também se faz à mão: carregar o `.bin` para `docs/firmware/...` pelo site do GitHub e
acrescentar a versão em `docs/firmware/catalog.json` (os campos `md5` e `tamanho` são opcionais).

### Site (GitHub Pages)

**https://jorgefpin.github.io/esp32-flash/**

Configuração: **Settings → Pages → Source: Deploy from a branch → `main` / `/docs`**.
Link de um produto: `https://jorgefpin.github.io/esp32-flash/?produto=<id>` (ex.: `?produto=demo`).

> Este repositório é público: tudo o que está em `docs/firmware/` pode ser descarregado por
> qualquer pessoa. Coloque aqui só firmwares (`.bin`), nunca o código-fonte privado.

### Testes

```bash
npm test
```

Testa a análise de `.bin` (com os firmwares reais de ESP32 e ESP32-S3), o MD5 e a divisão em blocos
que mantém os dados. A gravação completa foi também testada no Chromium contra um ESP32 emulado
(QEMU da Espressif): gravação, verificação MD5, atualização a manter NVS/SPIFFS e bloqueio de chip
errado.
