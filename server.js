'use strict';

const express      = require('express');
const path         = require('path');
const fs           = require('fs');
const { chromium } = require('playwright');

const app  = express();
const PORT = 3000;

const USER_AGENT     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const DATA_DIR       = path.join(__dirname, 'data');
const WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ─── Pre-Modern legální edice (Fourth Edition – Scourge, 1995–2003) ──────── */

const PREMODERN_EDITIONS = [
  // Základní sady
  '4th Edition', 'Fourth Edition',
  '5th Edition', 'Fifth Edition',
  '6th Edition', 'Sixth Edition', 'Classic Sixth',
  '7th Edition', 'Seventh Edition',
  // Ice Age blok
  'Ice Age', 'Chronicles', 'Homelands', 'Alliances',
  // Mirage blok
  'Mirage', 'Visions', 'Weatherlight',
  // Tempest blok
  'Tempest', 'Stronghold', 'Exodus',
  // Urza blok
  "Urza's Saga", "Urza's Legacy", "Urza's Destiny",
  // Masques blok
  'Mercadian Masques', 'Nemesis', 'Prophecy',
  // Invasion blok
  'Invasion', 'Planeshift', 'Apocalypse',
  // Odyssey blok
  'Odyssey', 'Torment', 'Judgment',
  // Onslaught blok
  'Onslaught', 'Legions', 'Scourge',
];

// Zobrazitelné názvy edicí pro frontend dropdown
const EDITION_LABELS = [
  'Fourth Edition', 'Ice Age', 'Chronicles', 'Homelands', 'Alliances',
  'Mirage', 'Visions', 'Fifth Edition', 'Weatherlight',
  'Tempest', 'Stronghold', 'Exodus',
  "Urza's Saga", "Urza's Legacy", 'Classic Sixth Edition', "Urza's Destiny",
  'Mercadian Masques', 'Nemesis', 'Prophecy',
  'Invasion', 'Planeshift', 'Seventh Edition', 'Apocalypse', 'Odyssey',
  'Torment', 'Judgment', 'Onslaught', 'Legions', 'Scourge',
];

// Normalizuje různé varianty apostrofu na standardní '
function normalizeApos(s) {
  return (s || '').replace(/[\u00B4\u2018\u2019\u02BC`]/g, "'");
}

function isPremodern(edition) {
  const e = normalizeApos(edition).toLowerCase();
  return PREMODERN_EDITIONS.some(pat => e.includes(normalizeApos(pat).toLowerCase()));
}

/* ─── Watchlist persistence ──────────────────────────────────────────────── */

function loadWatchlist() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(WATCHLIST_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8')); }
  catch { return []; }
}

function saveWatchlist(list) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2), 'utf8');
}

/* ─── Sdílená extrakce karet z jedné stránky ─────────────────────────────── */

function extractCardsFromPage(page) {
  return page.evaluate(() => {
    const allRows = Array.from(document.querySelectorAll('tr'));
    const cards   = [];

    for (let i = 0; i < allRows.length; i++) {
      const cellsC = Array.from(allRows[i].querySelectorAll('td'));
      if (cellsC.length !== 4) continue;

      const rowText = allRows[i].innerText || '';
      if (!rowText.includes('Kč') || !rowText.includes('ks')) continue;

      const priceM = (cellsC[2].innerText || '').match(/([\d\s]+)\s*Kč/);
      if (!priceM) continue;
      const price = parseInt(priceM[1].replace(/\s/g, ''), 10);
      if (!price) continue;

      const qtyM    = (cellsC[1].innerText || '').match(/(\d+)\s*ks/i);
      const quantity = qtyM ? parseInt(qtyM[1], 10) : 0;

      let name = '', edition = '';

      for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
        const prevCells = Array.from(allRows[j].querySelectorAll('td'));

        if (prevCells.length === 2 && !edition) {
          const hasEditionImg = Array.from(prevCells[0].querySelectorAll('img'))
            .some(img => (img.getAttribute('src') || '').includes('/kusovky/'));
          if (hasEditionImg)
            edition = (prevCells[0].innerText || '').replace(/\s+/g, ' ').trim();
        }

        if (prevCells.length === 3 && !name) {
          const t = (prevCells[1].innerText || '').replace(/\s+/g, ' ').trim();
          if (t && t.length > 1 && t.length <= 80) name = t;
        }

        if (name && edition) break;
      }

      if (!name) continue;
      cards.push({ name, edition: edition || '–', price, quantity });
    }

    return cards;
  });
}

/* ─── Vyhledání všech stránek pro daný dotaz ─────────────────────────────── */

async function searchAllPages(page, q) {
  const PAGE_SIZE = 30;
  const firstUrl  = `https://www.cernyrytir.cz/index.php3?akce=3&jmenokarty=${encodeURIComponent(q)}&edice_magic=0&submit=Vyhledej`;
  await page.goto(firstUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const totalCount = await page.evaluate(() => {
    const m = document.body.innerText.match(/Nalezeno\s+(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  });

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const allCards   = [];
  const seen       = new Set();

  for (const c of await extractCardsFromPage(page)) {
    const key = `${c.name}|${c.edition}|${c.price}`;
    if (!seen.has(key)) { seen.add(key); allCards.push(c); }
  }

  for (let p = 2; p <= totalPages; p++) {
    const offset  = (p - 1) * PAGE_SIZE;
    const nextUrl = `https://www.cernyrytir.cz/index.php3?akce=3&limit=${offset}&jmenokarty=${encodeURIComponent(q)}&edice_magic=libovolna&poczob=${PAGE_SIZE}&triditpodle=ceny&hledej_pouze_magic=1&submit=Vyhledej`;
    await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    for (const c of await extractCardsFromPage(page)) {
      const key = `${c.name}|${c.edition}|${c.price}`;
      if (!seen.has(key)) { seen.add(key); allCards.push(c); }
    }
  }

  return allCards;
}

/* ─── Search endpoint ────────────────────────────────────────────────────── */

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Chybí parametr q' });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx  = await browser.newContext({ userAgent: USER_AGENT });
    const page = await ctx.newPage();

    const allCards = await searchAllPages(page, q);
    const filtered = allCards.filter(c => isPremodern(c.edition));
    res.json({ query: q, count: filtered.length, cards: filtered });
  } catch (err) {
    console.error('[search] Chyba:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

/* ─── Editions endpoint (pro frontend dropdown) ──────────────────────────── */

app.get('/api/editions', (_req, res) => {
  res.json(EDITION_LABELS);
});

/* ─── Watchlist endpoints ────────────────────────────────────────────────── */

app.get('/api/watchlist', (_req, res) => {
  res.json(loadWatchlist());
});

app.post('/api/watchlist', (req, res) => {
  const { name, edition } = req.body || {};
  if (!name || !edition) return res.status(400).json({ error: 'Chybí name nebo edition' });

  const list  = loadWatchlist();
  const entry = {
    id       : Date.now().toString(),
    name     : name.trim(),
    edition  : edition.trim(),
    price    : null,
    quantity : null,
    lastUpdated: null,
  };
  list.push(entry);
  saveWatchlist(list);
  res.json(entry);
});

app.delete('/api/watchlist/:id', (req, res) => {
  const list = loadWatchlist().filter(e => e.id !== req.params.id);
  saveWatchlist(list);
  res.json({ ok: true });
});

app.post('/api/watchlist/refresh', async (req, res) => {
  const list = loadWatchlist();
  if (list.length === 0) return res.json([]);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx  = await browser.newContext({ userAgent: USER_AGENT });
    const page = await ctx.newPage();

    for (const entry of list) {
      const results = await searchAllPages(page, entry.name);
      // Najdi řádek kde edice odpovídá
      const entryEd = normalizeApos(entry.edition).toLowerCase();
      const match = results.find(c => {
        const cardEd = normalizeApos(c.edition).toLowerCase();
        return cardEd.includes(entryEd) || entryEd.includes(cardEd);
      });
      if (match) {
        entry.price       = match.price;
        entry.quantity    = match.quantity;
        entry.lastUpdated = new Date().toISOString();
      }
    }

    saveWatchlist(list);
    res.json(list);
  } catch (err) {
    console.error('[watchlist/refresh] Chyba:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

/* ─── Start ──────────────────────────────────────────────────────────────── */

app.listen(PORT, () => {
  console.log(`\n🔍  CR Search  →  http://localhost:${PORT}\n`);
});
