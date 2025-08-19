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
    playerName.replace(" ", "")
  )}`;
  console.log(url);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 90_000 });

  const profile = await page.evaluate(() => {
    const text = document.body.innerText;
    const ageMatch = text.match(/Age[: ]+([0-9.]+)/i);
    const playsMatch = text.match(/Plays[: ]+([^\n]+)/i);
    return {
      Age: ageMatch ? ageMatch[1].trim() : "",
      Plays: playsMatch ? playsMatch[1].trim() : "",
    };
  });

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
    const tournamentIdx = idx("Tournament");
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
          Tournament: get(tournamentIdx),
          Rk: get(rkIdx),
          vRk: get(vRkIdx),
          DR: get(drIdx),
          "A%": get(aPctIdx),
          "DF%": get(dfPctIdx),
          BPSvd: get(bpsvdIdx),
          Opponent: opponent,
        };
      })
      .filter((r) => r.Date); // üres sorok kiszűrése
  });

  return rows.map((r) => ({ ...r, ...profile }));
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

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
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
      await new Promise((resolve) => setTimeout(resolve, 1200));
    } catch (err) {
      console.error(`Hiba a(z) ${player} feldolgozásánál:`, err.message);
    }
  }

  await browser.close();

  // CSV kiírás
  const headers = [
    "Player",
    "Age",
    "Plays",
    "Date",
    "Tournament",
    "Rk",
    "vRk",
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
