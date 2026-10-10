# Manual — ESP32 Flash via WEB (by Jorge Pinheiro)

Processo completo, desde compilar o firmware até o cliente o instalar na placa.

**Site:** https://jorgefpin.github.io/esp32-flash/
**Repositório:** https://github.com/JorgeFPin/esp32-flash

---

## Índice

1. [Como funciona](#1-como-funciona)
2. [Onde fica cada coisa](#2-onde-fica-cada-coisa)
3. [Preparar o PC (só uma vez)](#3-preparar-o-pc-só-uma-vez)
4. [Gerar o firmware no Arduino IDE](#4-gerar-o-firmware-no-arduino-ide)
5. [Firmware público](#5-firmware-público)
6. [Firmware protegido para um cliente](#6-firmware-protegido-para-um-cliente)
   - 6.1 [Criar o cliente](#61-criar-o-cliente)
   - 6.2 [Publicar o firmware do cliente](#62-publicar-o-firmware-do-cliente)
   - 6.3 [Enviar para o GitHub](#63-enviar-para-o-github)
   - 6.4 [Obter o link do cliente](#64-obter-o-link-do-cliente)
   - 6.5 [Enviar o link ao cliente](#65-enviar-o-link-ao-cliente)
   - 6.6 [O que o cliente faz](#66-o-que-o-cliente-faz)
   - 6.7 [Nova versão para um cliente](#67-nova-versão-para-um-cliente)
   - 6.8 [Retirar acesso, trocar chave, apagar versões](#68-retirar-acesso-trocar-chave-apagar-versões)
7. [Cópia de segurança das chaves (importante)](#7-cópia-de-segurança-das-chaves-importante)
8. [Opções da página de gravação](#8-opções-da-página-de-gravação)
9. [Resolução de problemas](#9-resolução-de-problemas)
10. [Segurança: o que está e não está protegido](#10-segurança-o-que-está-e-não-está-protegido)
11. [Referência rápida de comandos](#11-referência-rápida-de-comandos)

---

## 1. Como funciona

```
 O SEU PC                              GITHUB (público)                      PC DO CLIENTE
 ────────                              ────────────────                      ─────────────
 Arduino IDE                           repositório esp32-flash               Chrome / Edge
   │ Exportar binário                    docs/  ──► GitHub Pages ──────────►  abre o link
   ▼                                     (site)     jorgefpin.github.io        │
 sketch.ino.merged.bin                                                         │ escolhe a porta COM
   │                                                                           ▼
   │ node tools/publicar-firmware.mjs                                        a página descarrega,
   │   (valida; se for de cliente: comprime + cifra)                         decifra, confirma o MD5,
   ▼                                                                         grava, verifica e reinicia
 docs/firmware/...  ── git push ──►    docs/firmware/...                       a placa ESP32 / ESP32-S3
 segredos/clientes.json  (NUNCA vai para o GitHub: tem as chaves)
```

Há dois tipos de firmware:

| | **Público** | **Protegido (por cliente)** |
|---|---|---|
| Quem pode instalar | Qualquer pessoa com o link | Só quem tiver o link/código desse cliente |
| Link | `…/?produto=<id>` | `…/?c=<cliente>&produto=<id>#k=<chave>` |
| Ficheiro no GitHub | `.bin` normal | `.bin.enc` (comprimido e cifrado, AES-256) |
| Aparece na lista da página principal | Sim | Não |

A chave do cliente vai no link **depois do `#`**. O browser nunca envia essa parte ao servidor: fica só no PC do cliente.

---

## 2. Onde fica cada coisa

```
esp32-flash/
├── docs/                         ← o site (o GitHub Pages publica esta pasta)
│   ├── index.html                   página de gravação
│   ├── css/  js/  vendor/           código da página (não é preciso mexer)
│   └── firmware/
│       ├── catalog.json             lista dos firmwares PÚBLICOS
│       ├── demo/1.0.0/…bin          firmware público de exemplo
│       └── clientes/
│           └── c3f8a…/              uma pasta por cliente (o nome é um código, não o nome do cliente)
│               ├── catalogo.enc       lista cifrada dos firmwares desse cliente
│               └── termostato/1.2.0/termostato-v1.2.0-esp32.bin.enc
├── tools/
│   ├── publicar-firmware.mjs     publicar uma versão (pública ou de cliente)
│   └── clientes.mjs              criar clientes, ver links, trocar chaves, apagar
├── segredos/clientes.json        ← CHAVES DOS CLIENTES — só no seu PC (está no .gitignore)
├── exemplos/demo-flash-web/      sketch Arduino do firmware de exemplo
├── tests/                        testes automáticos (npm test)
└── MANUAL.md                     este manual
```

> **Regra de ouro:** `segredos/clientes.json` nunca vai para o GitHub. O `.gitignore` já o impede, e
> os scripts param com um aviso se ele alguma vez for adicionado ao git.

---

## 3. Preparar o PC (só uma vez)

1. **Node.js** (versão LTS): https://nodejs.org → instalar com as opções por defeito.
2. **Git**: https://git-scm.com/download/win → instalar com as opções por defeito.
   (Alternativa com janelas: **GitHub Desktop**, https://desktop.github.com.)
3. **Copiar o repositório para o PC**: abrir a **Linha de comandos** (menu Iniciar → escrever `cmd`).
   Os comandos deste manual estão na sintaxe da Linha de comandos (`cmd`).
   ```
   cd %USERPROFILE%\Documents
   git clone https://github.com/JorgeFPin/esp32-flash.git
   cd esp32-flash
   npm test
   ```
   O `npm test` deve terminar com `fail 0`.
4. Na primeira vez que fizer `git push`, o Git pede para entrar na conta do GitHub (janela do browser).

**Antes de cada sessão de trabalho**, atualize a cópia local, sobretudo se usar mais de um PC:
```
cd %USERPROFILE%\Documents\esp32-flash
git pull
```

> Todos os comandos deste manual são escritos **dentro da pasta `esp32-flash`**.

---

## 4. Gerar o firmware no Arduino IDE

Faça isto **uma vez para cada chip** (ESP32 e/ou ESP32-S3).

1. **Ferramentas → Placa**: `ESP32 Dev Module` (ESP32) ou `ESP32S3 Dev Module` (ESP32-S3).
   Use o core **esp32 da Espressif versão 3.x** (Ferramentas → Placa → Gestor de placas).
2. Confirme em **Ferramentas**:
   - **Flash Size**: o tamanho real da flash da placa (ex.: 4MB, 8MB, 16MB).
   - **Partition Scheme**: o mesmo em todas as versões do produto. Se mudar o esquema, as
     definições guardadas na placa perdem-se na atualização (a página avisa).
   - **Flash Mode**: `QIO` serve para a maioria das placas; use `DIO` se houver placas que não arrancam.
3. Ponha a versão no código, por exemplo `#define VERSAO "1.2.0"`, e mostre-a no `Serial` ao arrancar.
   Ajuda a confirmar no **Monitor série** que a versão certa foi instalada.
4. **Sketch → Exportar binário compilado** (`Alt+Ctrl+S`).
5. **Sketch → Mostrar pasta do sketch** → pasta `build` → subpasta da placa:
   - ESP32: `build\esp32.esp32.esp32\<sketch>.ino.merged.bin`
   - ESP32-S3: `build\esp32.esp32.esp32s3\<sketch>.ino.merged.bin`

   **Use sempre o `.merged.bin`.** É o ficheiro completo (bootloader + partições + aplicação).
   Os outros (`.ino.bin`, `.bootloader.bin`, `.partitions.bin`) são rejeitados pelo script e pela página.

> Dica: copie os `.merged.bin` para uma pasta com nome claro, por exemplo
> `C:\firmwares\termostato\1.2.0\`, antes de publicar. Se compilar para o S3 depois do ESP32,
> o Arduino escreve noutra subpasta, por isso os dois ficheiros não se sobrepõem.

---

## 5. Firmware público

Para firmwares que qualquer pessoa pode instalar (ex.: demonstrações, produtos sem restrições).

```
node tools/publicar-firmware.mjs --produto termostato --nome "Termostato" --versao 1.0.0 ^
     --notas "Primeira versão" ^
     --esp32 C:\firmwares\termostato\1.0.0\termostato.ino.merged.bin ^
     --esp32s3 C:\firmwares\termostato\1.0.0\termostato_s3.ino.merged.bin
git add docs/firmware
git commit -m "Termostato v1.0.0"
git push
```

O `^` no fim da linha continua o comando na linha seguinte (Linha de comandos). Também pode escrever
tudo numa só linha. No PowerShell use `` ` `` em vez de `^`.

- **Link:** `https://jorgefpin.github.io/esp32-flash/?produto=termostato`
- **Nova versão:** o mesmo comando com `--versao 1.1.0`. O link continua o mesmo e instala sempre a
  versão mais recente. O `--nome` só é obrigatório na primeira vez.
- **Uma versão específica:** `…/?produto=termostato&versao=1.0.0`

---

## 6. Firmware protegido para um cliente

### 6.1 Criar o cliente

```
node tools/clientes.mjs novo --nome "Hotel Sol"
```

- Cria uma chave aleatória para o cliente e guarda-a em `segredos/clientes.json`.
- Cria a pasta `docs/firmware/clientes/<id>/`. O `<id>` é um código aleatório, por isso o nome do
  cliente não aparece em lado nenhum no GitHub.
- **Faça já a cópia de segurança** de `segredos/clientes.json` ([secção 7](#7-cópia-de-segurança-das-chaves-importante)).

### 6.2 Publicar o firmware do cliente

Igual ao firmware público, mas com `--cliente`:

```
node tools/publicar-firmware.mjs --cliente "Hotel Sol" --produto termostato --nome "Termostato Hotel Sol" ^
     --versao 1.0.0 --notas "Versão inicial" ^
     --esp32 C:\firmwares\hotelsol\1.0.0\termostato.ino.merged.bin
```

O script:
1. confirma que cada ficheiro é um `.merged.bin` válido para o chip indicado (`--esp32` / `--esp32s3`);
2. comprime e **cifra** o firmware com a chave desse cliente (4 MB passam a ~200 KB);
3. grava-o em `docs/firmware/clientes/<id>/termostato/1.0.0/…bin.enc`;
4. atualiza a lista cifrada `catalogo.enc` desse cliente;
5. mostra o **link para enviar ao cliente**.

Opções úteis:
- `--descricao "…"`: descrição do produto, mostrada ao cliente.
- `--manter-dados nao`: obriga a apagar as definições guardadas na placa ao instalar esta versão.
- `--substituir`: volta a publicar uma versão que já existe (por exemplo, para corrigir um ficheiro).
- O mesmo cliente pode ter vários produtos: basta usar outro `--produto`.

### 6.3 Enviar para o GitHub

```
git add docs/firmware
git commit -m "Hotel Sol: termostato v1.0.0"
git push
```

Em 1 a 2 minutos o site fica atualizado. Para confirmar: no GitHub, separador **Actions** →
"pages build and deployment" com ✓ verde.

> O `git status` **nunca** deve mostrar `segredos/`. Se mostrar, não faça commit e veja a [secção 9](#9-resolução-de-problemas).

### 6.4 Obter o link do cliente

A qualquer momento (não é preciso republicar):

```
node tools/clientes.mjs link --cliente "Hotel Sol" --produto termostato
```

Dá um link deste tipo:
```
https://jorgefpin.github.io/esp32-flash/?c=c3f8a1b2c3d&produto=termostato#k=Xk29…(43 caracteres)
```

- **Sem `--produto`:** o link abre a lista de **todos** os firmwares desse cliente. Se só houver um,
  abre-o diretamente.
- **Para ver todos os clientes, produtos, versões e links:** `node tools/clientes.mjs lista`

### 6.5 Enviar o link ao cliente

**Opção A: simples (link com a chave).** Envie o link completo por email ou WhatsApp. Quem tiver o
link consegue instalar, por isso envie-o só para o contacto certo.

**Opção B: mais segura (link e código separados).**
```
node tools/clientes.mjs link --cliente "Hotel Sol" --produto termostato --sem-chave
```
Dá o link **sem** a chave e o **código de acesso** à parte. Envie o link por email e o código por
SMS ou WhatsApp. Sem os dois não é possível instalar.

**Mensagem modelo para o cliente:**

> Olá,
>
> Para atualizar o firmware do seu equipamento:
>
> 1. Use um computador com **Google Chrome** ou **Microsoft Edge** (não funciona em telemóvel nem no Firefox/Safari).
> 2. Ligue o equipamento ao computador com um cabo USB.
> 3. Abra este link: **<link>**
>    *(se pedir um código de acesso, use: **<código>**)*
> 4. Clique em **Ligar** e escolha a porta que aparece (ex.: COM3, USB-SERIAL CH340, CP210x).
> 5. Clique em **Instalar** e aguarde até aparecer **✔ instalado e verificado com sucesso** (cerca de 30 segundos a 1 minuto).
>    Não desligue o cabo durante a instalação.
> 6. No fim pode desligar o cabo. As suas definições (Wi-Fi, etc.) são mantidas.
>
> Se a porta não aparecer, pode ser preciso instalar o driver USB. Na página, em "Problemas comuns", estão os links.
>
> Jorge Pinheiro

### 6.6 O que o cliente faz

1. **Abre o link** no Chrome ou no Edge. Vê o nome do produto, a versão, a data e as notas, e no topo
   "Atualização de firmware · <nome do cliente>".
   - Se o link não tiver a chave, aparece **"Firmware protegido"**. O cliente cola o código e clica em **Continuar**.
   - Se o código estiver errado (ou for de outro cliente), aparece **"Código de acesso errado"** e
     não se vê nada do firmware.
2. **Ligar:** escolhe a porta COM. A página deteta o chip (ESP32 ou ESP32-S3), descarrega o
   firmware certo para esse chip, decifra-o e confirma o MD5.
3. **Instalar:** a página grava, confirma por MD5 o que ficou na flash e reinicia a placa.
   - Numa atualização (mesmo esquema de partições), as definições guardadas na placa são **mantidas**
     automaticamente.
4. No fim aparece **✔ … instalado e verificado com sucesso**.

### 6.7 Nova versão para um cliente

```
node tools/publicar-firmware.mjs --cliente "Hotel Sol" --produto termostato --versao 1.1.0 ^
     --notas "Corrige leitura do sensor" --esp32 C:\firmwares\hotelsol\1.1.0\termostato.ino.merged.bin
git add docs/firmware
git commit -m "Hotel Sol: termostato v1.1.0"
git push
```

**O cliente usa o mesmo link de sempre** e passa a receber a v1.1.0. Não é preciso enviar nada de novo,
basta avisar que há atualização.

### 6.8 Retirar acesso, trocar chave, apagar versões

| Quero… | Comando | Efeito |
|---|---|---|
| Trocar a chave (ex.: o link foi partilhado com quem não devia) | `node tools/clientes.mjs nova-chave --cliente "Hotel Sol"` | Volta a cifrar tudo com uma chave nova. Depois do `git push`, o link antigo deixa de funcionar. Envie o link novo ao cliente. |
| Apagar uma versão | `node tools/clientes.mjs remover-versao --cliente "Hotel Sol" --produto termostato --versao 1.0.0` | Remove essa versão da lista e apaga o ficheiro. |
| Remover o cliente | `node tools/clientes.mjs remover --cliente "Hotel Sol" --confirmar` | Apaga a pasta do cliente. Depois do `git push`, o link mostra "Este link já não é válido". |

Depois de qualquer um destes comandos:
```
git add -A docs/firmware
git commit -m "…"
git push
```

> Veja na [secção 10](#10-segurança-o-que-está-e-não-está-protegido) o que acontece às versões antigas
> que ficam no histórico do Git.

---

## 7. Cópia de segurança das chaves (importante)

`segredos/clientes.json` tem as chaves de todos os clientes e só existe no seu PC.

**Se o perder:**
- os links que já enviou **continuam a funcionar** (os ficheiros no GitHub não mudam);
- mas **não consegue publicar versões novas** para esses clientes, nem voltar a ver os links.
  Teria de criar os clientes de novo e enviar links novos.

**O que fazer:** depois de criar um cliente ou trocar uma chave, copie o ficheiro para **dois** sítios
seguros, por exemplo:
- uma pen USB guardada; e/ou
- um gestor de passwords (Bitwarden, 1Password, KeePass) como anexo; e/ou
- o seu repositório **privado** `intelitherm` (nunca no `esp32-flash`, que é público).

**Para trabalhar noutro PC:** depois do `git clone`, crie a pasta `segredos` e coloque lá o
`clientes.json` da cópia de segurança.

---

## 8. Opções da página de gravação

- **Escolher a placa / Automático** (só no modo ficheiro local): bloqueia a gravação se o firmware,
  a placa escolhida e a placa ligada não forem o mesmo chip.
- **Velocidade:** 460800 por defeito. Se a gravação falhar a meio, use 115200.
- **Manter os dados guardados na placa:** fica ativo sozinho quando a placa já tem a mesma tabela de
  partições do firmware novo. Mantém NVS/Preferences (Wi-Fi, calibrações) e SPIFFS/LittleFS.
- **Apagar toda a flash antes de gravar:** instalação "de fábrica". Apaga também as definições.
- **Opções avançadas:** endereço de gravação manual, mostrar todas as portas série, ignorar verificações.
- **Monitor série:** ver as mensagens da placa depois de gravar (botão **Reiniciar placa**).
- **Registo → Copiar:** copia o registo completo, útil para o cliente lhe enviar quando há problemas.

**Gravar um `.bin` local** (sem catálogo): abra https://jorgefpin.github.io/esp32-flash/, escolha a
placa, escolha o ficheiro, **Ligar**, **Gravar e verificar**. Serve também para enviar um `.bin` por
email a um cliente, mas com o link protegido não é preciso.

---

## 9. Resolução de problemas

**No seu PC (scripts)**

| Mensagem | Causa / solução |
|---|---|
| `… foi compilado para ESP32-S3, não para ESP32` | Trocou os ficheiros: `--esp32` deve receber o binário compilado com `ESP32 Dev Module`. |
| `… contém só a aplicação. Use o ficheiro .merged.bin` | Escolheu o `.ino.bin`. Use o `.ino.merged.bin`. |
| `cliente "X" não encontrado` | O nome não coincide. Veja os nomes com `node tools/clientes.mjs lista`. |
| `não foi possível abrir o catálogo de … (a chave … está certa?)` | O `segredos/clientes.json` não corresponde aos ficheiros. Reponha a cópia de segurança certa. |
| `ATENÇÃO: segredos/clientes.json está no git!` | Corra `git rm --cached segredos/clientes.json`, confirme que `.gitignore` tem `segredos/` e **não faça push**. Se já tiver feito push, troque as chaves de todos os clientes (`nova-chave`). |
| `git push` recusado | Faça `git pull` e repita o `git push`. |
| Site não atualiza | Espere 2 minutos, veja **Actions** no GitHub e recarregue a página com `Ctrl+F5`. |

**No PC do cliente**

| Sintoma | Solução |
|---|---|
| "Este browser não permite aceder à porta série" | Usar Chrome ou Edge num computador. |
| A porta não aparece | Cabo USB de dados; driver CP210x ou CH340 (links na página); ativar "Mostrar todas as portas série". |
| "A placa não respondeu" | Manter **BOOT** premido, carregar em **RESET**, soltar **BOOT** e clicar **Ligar**. |
| "A porta está ocupada" | Fechar o Arduino IDE, monitores série e outros separadores da página. |
| Falha a meio | Velocidade 115200, sem hubs USB. |
| "Código de acesso errado" | Código incompleto, de outro cliente, ou a chave foi trocada. Envie o link atual (`clientes.mjs link`). |
| "Este link já não é válido" | O cliente foi removido ou o link está incompleto. |
| Não arranca depois de gravar | Carregar em **RESET**; repetir com **Apagar toda a flash**. |

---

## 10. Segurança: o que está e não está protegido

**Protegido:**
- Os firmwares de cliente estão cifrados com AES-256-GCM e uma chave aleatória por cliente.
  Sem a chave, os ficheiros no GitHub não servem para nada.
- A chave de um cliente não abre os firmwares de outro cliente.
- Os nomes dos clientes e dos produtos estão dentro do `catalogo.enc` cifrado. No GitHub só se veem códigos.
- Qualquer alteração a um ficheiro cifrado é detetada (a decifração falha).

**Limitações (saber isto):**
- **Quem tem o link (ou o código) consegue instalar.** Se o cliente o partilhar, outros também conseguem.
- **Histórico do Git:** o GitHub guarda as versões antigas dos ficheiros. Depois de `nova-chave` ou de
  `remover`, quem tinha a chave **antiga** e souber procurar no histórico consegue ainda obter as
  versões antigas. As versões novas ficam protegidas pela chave nova.
- **Cópia a partir da placa:** quem tem uma placa gravada consegue ler a flash com o `esptool` e
  copiar o firmware. Para impedir isso é preciso ativar no ESP32 a **Flash Encryption** e o
  **Secure Boot** (configuração permanente no chip, com processo de produção próprio).
- Não há registo de quem instalou o quê.

---

## 11. Referência rápida de comandos

```
# Clientes
node tools/clientes.mjs novo --nome "Hotel Sol"
node tools/clientes.mjs lista
node tools/clientes.mjs link --cliente "Hotel Sol" [--produto termostato] [--sem-chave]
node tools/clientes.mjs nova-chave --cliente "Hotel Sol"
node tools/clientes.mjs remover-versao --cliente "Hotel Sol" --produto termostato --versao 1.0.0
node tools/clientes.mjs remover --cliente "Hotel Sol" --confirmar

# Publicar (sem --cliente = público)
node tools/publicar-firmware.mjs [--cliente "Hotel Sol"] --produto termostato [--nome "Nome"] --versao 1.2.0 ^
     [--descricao "..."] [--notas "..."] [--manter-dados nao] [--substituir] ^
     --esp32 <ficheiro.merged.bin> [--esp32s3 <ficheiro.merged.bin>]

# Enviar para o GitHub (depois de qualquer alteração)
git add -A docs/firmware
git commit -m "descrição"
git push

# Testes
npm test
```

### Exemplos incluídos no site

- **Público:** https://jorgefpin.github.io/esp32-flash/?produto=demo
- **Protegido ("Cliente Demo", só para testar; esta chave é pública de propósito):**
  https://jorgefpin.github.io/esp32-flash/?c=c3179d59d78&produto=demo-protegido#k=bJyyIz192XY0gCBbpNKc9gW7iKNnAWaPCA_fkeZgfow

  O "Cliente Demo" não está no seu `segredos/clientes.json`. Para o retirar do site, apague a pasta
  `docs/firmware/clientes/c3179d59d78` e faça commit e push.
