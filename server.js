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
  // Staré sady (pre-4th)
  'Arabian Nights',
  'Antiquities',
  'Legends', 'Legends Italian', 'Italian Legends', 'Leggende',
  'The Dark',
  'Fallen Empires',
  'Alpha', 'Limited Edition Alpha',
  'Beta', 'Limited Edition Beta',
  'Unlimited',
  '3rd Edition', 'Revised Edition', 'Revised',
  'Asian Black Bordered', 'Asian BB',
  'Foreign Black Bordered', 'FBB',
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

// Zobrazitelné názvy edicí pro frontend dropdown (abecedně)
const EDITION_LABELS = [
  '3rd Edition',
  'Alliances',
  'Alpha',
  'Antiquities',
  'Apocalypse',
  'Arabian Nights',
  'Asian Black Bordered',
  'Beta',
  'Chronicles',
  'Classic Sixth Edition',
  'Exodus',
  'Fallen Empires',
  'Fifth Edition',
  'Foreign Black Bordered',
  'Fourth Edition',
  'Homelands',
  'Ice Age',
  'Invasion',
  'Judgment',
  'Legends',
  'Legends Italian',
  'Legions',
  'Mercadian Masques',
  'Mirage',
  'Nemesis',
  'Odyssey',
  'Onslaught',
  'Planeshift',
  'Prophecy',
  'Revised',
  'Scourge',
  'Seventh Edition',
  'Stronghold',
  'Tempest',
  'The Dark',
  'Torment',
  'Unlimited',
  "Urza's Destiny",
  "Urza's Legacy",
  "Urza's Saga",
  'Visions',
  'Weatherlight',
];

// Normalizuje různé varianty apostrofu na standardní '
function normalizeApos(s) {
  return (s || '').replace(/[\u00B4\u2018\u2019\u02BC`]/g, "'");
}

function isPremodern(edition) {
  const e = normalizeApos(edition).toLowerCase().trim();
  return PREMODERN_EDITIONS.some(pat => {
    const p = normalizeApos(pat).toLowerCase().trim();
    // Exact match nebo edition začíná vzorem (následovaným non-word znakem nebo koncem)
    return e === p || (e.startsWith(p) && (e.length === p.length || /\W/.test(e[p.length])));
  });
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

/* ─── Najada API search ──────────────────────────────────────────────────── */

const NAJADA_GAME_ID = '40e972fe-c136-4d66-b61a-89f6be0f93d5';

async function searchNajada(query) {
  const url = `https://najada.games/api/v1/najada2/catalog/mtg-singles/` +
    `?expansion__game=${NAJADA_GAME_ID}&o=price&in_stock=false` +
    `&q=${encodeURIComponent(query)}&article_price_min=0&article_price_max=10000000&limit=200&offset=0`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept'    : 'application/json',
      'Referer'   : 'https://www.najada.games/',
    },
  });

  if (!resp.ok) throw new Error(`Najada API vrátila ${resp.status}`);

  const json    = await resp.json();
  const results = [];

  for (const item of json.results || []) {
    const edition = item.expansion?.localized_name || '';
    if (!isPremodern(edition)) continue;

    for (const article of item.articles || []) {
      results.push({
        name     : item.localized_name || item.name,
        edition,
        price    : article.effective_price_czk,
        quantity : article.total_availability || 0,
        condition: article.condition || '–',
        shop     : 'Najáda',
      });
    }
  }

  return results;
}

/* ─── Search endpoint ────────────────────────────────────────────────────── */

app.get('/api/search', async (req, res) => {
  const q     = (req.query.q || '').trim();
  const shops = (req.query.shops || 'cr,najada').split(',').map(s => s.trim());
  if (!q) return res.status(400).json({ error: 'Chybí parametr q' });

  const tasks = [];

  if (shops.includes('cr')) {
    tasks.push((async () => {
      let browser;
      try {
        browser = await chromium.launch({ headless: true });
        const ctx  = await browser.newContext({ userAgent: USER_AGENT });
        const page = await ctx.newPage();
        const all  = await searchAllPages(page, q);
        return all
          .filter(c => isPremodern(c.edition))
          .map(c => ({ ...c, condition: '–', shop: 'Černý Rytíř' }));
      } finally {
        if (browser) await browser.close();
      }
    })());
  }

  if (shops.includes('najada')) {
    tasks.push(searchNajada(q));
  }

  const settled = await Promise.allSettled(tasks);
  const cards   = [];
  const errors  = [];

  for (const s of settled) {
    if (s.status === 'fulfilled') cards.push(...s.value);
    else errors.push(s.reason?.message || String(s.reason));
  }

  if (errors.length) console.error('[search] Errors:', errors);
  res.json({ query: q, count: cards.length, cards, errors });
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

  // Najada – všechny karty paralelně přes API
  const najadaSettled = await Promise.allSettled(
    list.map(entry => searchNajada(entry.name))
  );

  // CR – sekvenčně přes jeden Playwright browser
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx  = await browser.newContext({ userAgent: USER_AGENT });
    const page = await ctx.newPage();

    for (let i = 0; i < list.length; i++) {
      const entry   = list[i];
      const entryEd = normalizeApos(entry.edition).toLowerCase();

      function editionMatch(c) {
        const cardEd = normalizeApos(c.edition).toLowerCase();
        return cardEd.includes(entryEd) || entryEd.includes(cardEd);
      }

      // CR
      try {
        const crAll   = await searchAllPages(page, entry.name);
        const crMatch = crAll.find(editionMatch) || null;
        entry.cr_price    = crMatch ? crMatch.price    : null;
        entry.cr_quantity = crMatch ? crMatch.quantity : null;
      } catch (e) {
        console.error(`[watchlist/refresh] CR chyba pro "${entry.name}":`, e.message);
        entry.cr_price    = null;
        entry.cr_quantity = null;
      }

      // Najáda – ulož VŠECHNY naskladněné kvality, seřazené od nejlevnější
      if (najadaSettled[i].status === 'fulfilled') {
        const cards   = najadaSettled[i].value.filter(editionMatch);
        const inStock = cards.filter(c => c.quantity > 0).sort((a, b) => a.price - b.price);
        // Pokud nic není skladem, ulož referenční cenu (nejlevnější)
        const fallback = !inStock.length ? cards.sort((a, b) => a.price - b.price).slice(0, 1) : [];
        entry.najada_articles = (inStock.length ? inStock : fallback).map(a => ({
          price    : a.price,
          quantity : a.quantity,
          condition: a.condition,
        }));
      } else {
        entry.najada_articles = [];
      }

      entry.lastUpdated = new Date().toISOString();
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
