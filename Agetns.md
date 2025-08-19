# Condex Agents – TennisAbstract Scraper (Puppeteer)

## Cél

Terminálból futtatható Node.js alkalmazás, amely a **Puppeteer** segítségével felkeresi a megadott teniszezők oldalát a Tennis Abstracten és kinyeri az utóbbi meccsek adatait a fő meccs-táblázatból. Az eredményt egy **CSV** fájlba menti.

Forrás URL sablon: `https://www.tennisabstract.com/cgi-bin/player.cgi?p=[tennisPlayerName]`

## Kinyerendő mezők

- `Date`
- `Rk`
- `DR`
- `A%`
- `DF%`
- `BPSvd`
- **Opponent** (külön kérésre: az ellenfél neve). Az ellenfél neve a táblázatban a `vRk` és a `Score` oszlop **között** található cellában, és **mindig kattintható** (anchor `<a>`), ezért link segítségével azonosítjuk.
- `Winner` (a győztes neve; ha az ellenfél neve a "d." előtt szerepel, akkor ő nyert, különben a forrás játékos).

## Bemenet és kimenet

- **Bemenet:** egy `players.txt` fájl, soronként egy játékosnévvel (úgy, ahogy a Tennis Abstract URL-ben használható), pl. `Novak Djokovic`.
- **Kimenet:** `output.csv` (alapértelmezett név felülírható), amely soronként tartalmazza a fenti mezőket és a `Player` (forrás játékos) mezőt.

---

## Fő script: `scrape-tennisabstract.js`

```javascript
#!/usr/bin/env node
/**
 * Tennis Abstract scraper Puppeteer-rel
 * Használat: node scrape-tennisabstract.js players.txt output.csv
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const puppeteer = require("puppeteer");

function escapeCSV(value) {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function readPlayers(filePath) {
  const players = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const name = line.trim();
    if (name) players.push(name);
  }
  return players;
}

async function scrapePlayer(page, playerName) {
  const url = `https://www.tennisabstract.com/cgi-bin/player.cgi?p=${encodeURIComponent(
    playerName
  )}`;
  await page.goto(url, { waitUntil: "networkidle2", timeout: 90_000 });

  // Keressük meg azt a táblázatot, amelynek a fejléce többek közt tartalmazza a Date és Score oszlopokat
  await page.waitForFunction(
    () => {
      const tables = Array.from(document.querySelectorAll("table"));
      return tables.some((t) => {
        const headers = Array.from(
          t.querySelectorAll("thead tr th, tr th")
        ).map((th) => th.textContent.trim());
        return headers.includes("Date") && headers.includes("Score");
      });
    },
    { timeout: 60_000 }
  );

  const rows = await page.evaluate(() => {
    function getHeaders(table) {
      const ths = Array.from(table.querySelectorAll("thead tr th"));
      const headerRow = ths.length
        ? ths
        : Array.from(table.querySelectorAll("tr th"));
      return headerRow.map((th) => th.textContent.trim());
    }

    const tables = Array.from(document.querySelectorAll("table"));
    let target = null;
    for (const t of tables) {
      const headers = getHeaders(t);
      if (headers.includes("Date") && headers.includes("Score")) {
        target = t;
        break;
      }
    }
    if (!target) return [];

    const headers = getHeaders(target);
    const idx = (name) => headers.indexOf(name);

    const dateIdx = idx("Date");
    const rkIdx = idx("Rk");
    const drIdx = idx("DR");
    const aPctIdx = idx("A%");
    const dfPctIdx = idx("DF%");
    const bpsvdIdx = idx("BPSvd");
    const vRkIdx = idx("vRk");
    const scoreIdx = idx("Score");

    // Ellenfél oszlop: a vRk és a Score között, és benne egy <a> link a játékos nevével
    const oppIdx =
      vRkIdx !== -1 && scoreIdx !== -1 ? Math.min(vRkIdx, scoreIdx) + 1 : -1;

    const bodyRows = Array.from(target.querySelectorAll("tbody tr")).filter(
      (tr) => tr.querySelectorAll("td").length
    );

    return bodyRows
      .map((tr) => {
        const tds = Array.from(tr.querySelectorAll("td"));
        const get = (i) =>
          i >= 0 && i < tds.length ? tds[i].textContent.trim() : "";

        let opponent = "";
        if (oppIdx >= 0 && oppIdx < tds.length) {
          const link = tds[oppIdx].querySelector("a");
          opponent = link
            ? link.textContent.trim()
            : tds[oppIdx].textContent.trim();
        }

        return {
          Date: get(dateIdx),
          Rk: get(rkIdx),
          DR: get(drIdx),
          "A%": get(aPctIdx),
          "DF%": get(dfPctIdx),
          BPSvd: get(bpsvdIdx),
          Opponent: opponent,
        };
      })
      .filter((r) => r.Date); // üres sorok kiszűrése
  });

  return rows;
}

async function main() {
  const [, , playersFile, outputFileArg] = process.argv;
  if (!playersFile) {
    console.error(
      "Használat: node scrape-tennisabstract.js players.txt [output.csv]"
    );
    process.exit(1);
  }
  const outPath = outputFileArg || "output.csv";

  const players = await readPlayers(playersFile);
  if (!players.length) {
    console.error("A players.txt nem tartalmaz neveket.");
    process.exit(1);
  }

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

  const allRows = [];

  for (const player of players) {
    try {
      console.log(`>> Feldolgozás: ${player}`);
      const rows = await scrapePlayer(page, player);
      for (const r of rows) {
        allRows.push({ Player: player, ...r });
      }
      // udvarias késleltetés, hogy ne terheljük a szervert
      await page.waitForTimeout(1200);
    } catch (err) {
      console.error(`Hiba a(z) ${player} feldolgozásánál:`, err.message);
    }
  }

  await browser.close();

  // CSV kiírás
  const headers = [
    "Player",
    "Date",
    "Rk",
    "DR",
    "A%",
    "DF%",
    "BPSvd",
    "Opponent",
  ];
  const csv = [headers.map(escapeCSV).join(",")]
    .concat(
      allRows.map((row) => headers.map((h) => escapeCSV(row[h])).join(","))
    )
    .join("\n");

  fs.writeFileSync(outPath, csv, "utf-8");
  console.log(`\nKész: ${path.resolve(outPath)} (${allRows.length} sor)`);
}

main().catch((err) => {
  console.error("Váratlan hiba:", err);
  process.exit(1);
});
```

---

## Példa `players.txt`

```text
Novak Djokovic
Carlos Alcaraz
Iga Swiatek
```

> Tipp: Ha a név nem pontosan egyezik a Tennis Abstract formátumával, az oldal általában így is megnyílik. A script `encodeURIComponent`-tel kódolja a nevet.

---

## Telepítés és futtatás (lokálisan)

1. **Projekt mappa létrehozása és inicializálás**

   ```bash
   mkdir tennis-scraper && cd tennis-scraper
   npm init -y
   ```

2. **Függőségek telepítése**

   ```bash
   npm install puppeteer
   ```

3. **Fájlok létrehozása**

   - `scrape-tennisabstract.js` – másold be a fenti kódot
   - `players.txt` – soronként egy név

4. **Futtatás**

   ```bash
   node scrape-tennisabstract.js players.txt output.csv
   ```

   Az `output.csv` fájl a projekt mappában jön létre. Ha nem adsz meg kimeneti nevet, alapból `output.csv` lesz.

### Megjegyzések

- A script **headless** módban fut (láthatatlan böngésző). Ha hibakereséshez látni szeretnéd a böngészőt, indítsd így:

  ```bash
  PUPPETEER_EXECUTABLE_PATH="" node scrape-tennisabstract.js players.txt
  ```

  és módosítsd a kódban a `puppeteer.launch({ headless: false, slowMo: 50 })` beállításra.

- Ha tűzfal/proxy mögött vagy, a Puppeteer Chromium letöltése gondot okozhat. Ekkor állíts be környezeti változókat (`HTTPS_PROXY`) vagy add meg a lokális Chrome elérési útját a `puppeteer.launch({ executablePath: '.../chrome' })` opcióval.

---

## „Prompt” a Codex/Agent számára

Az alábbi prompttal a fejlesztői agent pontosan azt a viselkedést fogja megvalósítani, amit szeretnénk:

> **Feladat:** Készíts Node.js (ES2020) parancssori eszközt Puppeteerrel, amely egy `players.txt` fájlból soronként beolvasott teniszezők neve alapján megnyitja a `https://www.tennisabstract.com/cgi-bin/player.cgi?p=[tennisPlayerName]` oldalt, megkeresi a fő meccs-táblázatot (amelynek fejrészében szerepel a `Date` és a `Score` oszlop), és minden sorból kinyeri a következő mezőket: `Date`, `Rk`, `DR`, `A%`, `DF%`, `BPSvd`. Emellett kinyeri az **ellenfél nevét** is abból az oszlopból, amely a `vRk` és a `Score` között található, és amelynek cellájában kattintható link (`<a>`) van – ennek szövegét használd névként. Az összes adatot írd egy CSV-be (`output.csv`), és egészítsd ki egy `Player` mezővel, amely a forrás játékost tartalmazza. Ügyelj a táblázat robusztus felismerésére: a helyes táblázatot a fejléc alapján azonosítsd, az oszlopindexeket dinamikusan számítsd ki a fejlécszövegek (`Date`, `Rk`, `DR`, `A%`, `DF%`, `BPSvd`, `vRk`, `Score`) pozíciója szerint. Írj udvarias késleltetést a kérések közé (≥ 1 s), és kezeld az üres sorokat. A program a következőképp legyen futtatható: `node scrape-tennisabstract.js players.txt output.csv`. Adj teljes, önállóan futtatható kódot, és rövid futtatási útmutatót.

---

## Hibaelhárítás

- **Nem talál táblázatot:** ellenőrizd, hogy az oldal teljesen betöltött-e. A script `networkidle2`-t és egy `waitForFunction`-t használ a biztonság kedvéért.
- **Üres CSV / kevés sor:** lehet, hogy a Tennis Abstract csak részben tölti be a meccslistát. Frissítsd a név formátumát vagy próbálj másik játékossal.
- **Selector változás:** ha a Tennis Abstract megváltoztatja a táblázat struktúráját, a fejléc-alapú indexelés nagyobb eséllyel továbbra is működni fog, de szükség lehet kisebb módosításokra.

## Licenc

A példa kód szabadon felhasználható és módosítható a saját projektedben.
