'use strict';

require('dotenv').config();

const express      = require('express');
const path         = require('path');
const crypto       = require('crypto');
const fs           = require('fs');
const { chromium } = require('playwright-core');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const Database     = require('better-sqlite3');

const app  = express();
const PORT = process.env.PORT || 3000;

const USER_AGENT     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const JWT_SECRET     = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const MAX_WATCHLISTS = parseInt(process.env.MAX_WATCHLISTS || '100', 10);
const DATA_DIR       = path.join(__dirname, 'data');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ─── Changelog ──────────────────────────────────────────────────────────── */

const CHANGELOG = [
  { version: 'v4.0', changes: 'Known Issues přeorganizovány do sekcí dle závažnosti (High / Medium / Low / Info)' },
  { version: 'v3.9', changes: 'Mobilní optimalizace – header tlačítka jen emoji, search bar zalomení, skrytí sloupce #' },
  { version: 'v3.8', changes: 'Vyčištění Known Issues – odstraněny vyřešené záznamy (playwright-core, bcrypt redundance)' },
  { version: 'v3.7', changes: 'playwright → playwright-core: pouze Chromium (~280 MB místo ~900 MB), automatická instalace při deployi přes postinstall; oprava hover náhledu dle edice' },
  { version: 'v3.6', changes: 'Přidání do watchlistu přímo ze search (+); sloupec Počet ve watchlistu; obrázek karty při hoveru (Scryfall); vylepšená mobilní verze' },
  { version: 'v3.5', changes: 'Zelené zvýraznění dostupných karet sjednoceno – funguje nyní i ve výsledcích vyhledávání, nejen ve watchlistu' },
  { version: 'v3.4', changes: 'Aplikace přejmenována na Premodern; sekce O aplikaci (🧙); Known Issues a Changelog dostupné i v admin panelu' },
  { version: 'v3.3', changes: 'Admin panel: zobrazení plaintext hesla watchlistu – sloupec Heslo vedle ID hashe' },
  { version: 'v3.2', changes: 'Zobrazení jména watchlistu vedle Odhlásit – skryté pod tečkami, kliknutím se odhalí na 3 s; multi-edition picker; Known Issues sekce v hlavičce' },
  { version: 'v3.1', changes: 'Import z Moxfieldu – tlačítko Import, parsování textu, Scryfall API auto-detekce Pre-Modern edic, dropdown pro více možností' },
  { version: 'v3.0', changes: 'Watchlist chráněn heslem – vytvoření/přihlášení, JWT tokeny, SQLite DB, admin panel (/admin), migrace starých dat' },
  { version: 'v2.6', changes: 'Sloupec "Aktualizováno" odstraněn – čas přesunut vedle buttonu; Najáda rozdělena na 3 samostatné sloupce: NJ Stav / NJ Cena / NJ Sklad' },
  { version: 'v2.5', changes: 'Zelené zvýraznění řádku watchlistu pokud je karta skladem alespoň na jednom shopu' },
  { version: 'v2.4', changes: 'Watchlist zobrazuje všechny naskladněné kvality z Najády (dříve jen jedna), řazeno od nejlevnější' },
  { version: 'v2.3', changes: 'Dropdown edic ve watchlistu seřazen abecedně' },
  { version: 'v2.2', changes: 'Rozšíření edic: Alpha, Beta, Unlimited, 3rd Edition, Arabian Nights, Antiquities, Legends, Legends Italian, The Dark, Fallen Empires, Asian BB, FBB' },
  { version: 'v2.1', changes: 'Najáda přidána do watchlistu – refresh aktualizuje ceny z obou shopů, tabulka rozšířena o CR a Najáda sloupce' },
  { version: 'v2.0', changes: 'Přidána Najáda do vyhledávání – checkboxy pro výběr shopů, paralelní vyhledávání, nové sloupce Stav a Eshop' },
  { version: 'v1.0', changes: 'Základ: vyhledávání na Černý Rytíř, filtr Pre-Modern edic (4th Ed – Scourge), watchlist s uložením karet + aktualizací cen' },
];

app.get('/api/changelog', (_req, res) => res.json(CHANGELOG));

const KNOWN_ISSUES = [
  { id: 1, severity: 'low',    desc: 'Checkbox v multi-edition pickeru má příliš velkou mezeru od textu edice – kosmetický problém, funkčnost není dotčena' },
  { id: 2, severity: 'info',   desc: 'Integrace shopu Dobi (Cardmarket / Dobi-trading-DE) čeká na otevření Cardmarket API – momentálně nepřijímají nové žádosti o přístup, implementace proběhne jakmile API bude dostupné' },
  { id: 3, severity: 'medium', desc: 'Watchlist refresh pro karty s krátkým názvem (např. "Island") může vrátit i karty jejichž název začíná stejným slovem (např. "Island Fish Jasconius" z Arabian Nights), protože CR embedduje stav do názvu ve formátu "Karta - lightly played" a matching probíhá prefixem.' },
  { id: 5, severity: 'low',    desc: 'Mobilní UX – tabulky s mnoha sloupci nejsou na malých displejích optimální, vhodná další UX optimalizace (skrývání méně důležitých sloupců, responzivní layout).' },
];

app.get('/api/known-issues', (_req, res) => res.json(KNOWN_ISSUES));

/* ─── SQLite DB ──────────────────────────────────────────────────────────── */

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'cr-search.db'));
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS watchlists (
    id            TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    password_plain TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    last_accessed TEXT
  );

  CREATE TABLE IF NOT EXISTS watchlist_cards (
    id              TEXT PRIMARY KEY,
    watchlist_id    TEXT NOT NULL,
    name            TEXT NOT NULL,
    edition         TEXT NOT NULL,
    cr_price        REAL,
    cr_quantity     INTEGER,
    cr_articles     TEXT,
    najada_articles TEXT,
    last_updated    TEXT,
    FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE CASCADE
  );
`);

// Migrace – přidej cr_articles sloupec pokud chybí (starší DB)
try { db.exec('ALTER TABLE watchlist_cards ADD COLUMN cr_articles TEXT'); } catch { /* sloupec již existuje */ }
try { db.exec('ALTER TABLE watchlists ADD COLUMN password_plain TEXT'); } catch { /* sloupec již existuje */ }
try { db.exec('ALTER TABLE watchlist_cards ADD COLUMN qty_needed INTEGER DEFAULT 1'); } catch { /* sloupec již existuje */ }

/* ─── Migrace starého watchlist.json → SQLite ────────────────────────────── */

const OLD_WATCHLIST_FILE = path.join(DATA_DIR, 'watchlist.json');
const MIGRATION_PASSWORD = 'import1234';

async function migrateOldWatchlist() {
  if (!fs.existsSync(OLD_WATCHLIST_FILE)) return;
  const raw = fs.readFileSync(OLD_WATCHLIST_FILE, 'utf8');
  let cards;
  try { cards = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(cards) || cards.length === 0) return;

  const migId = crypto.createHash('sha256').update(MIGRATION_PASSWORD).digest('hex').slice(0, 32);
  if (db.prepare('SELECT id FROM watchlists WHERE id = ?').get(migId)) return; // už migrováno

  const hash = await bcrypt.hash(MIGRATION_PASSWORD, 10);
  db.prepare('INSERT INTO watchlists (id, password_hash) VALUES (?, ?)').run(migId, hash);

  const insert = db.prepare('INSERT INTO watchlist_cards (id, watchlist_id, name, edition, cr_price, cr_quantity, najada_articles, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const c of cards) {
    insert.run(
      c.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      migId,
      c.name,
      c.edition,
      c.cr_price ?? c.price ?? null,
      c.cr_quantity ?? c.quantity ?? null,
      c.najada_articles ? JSON.stringify(c.najada_articles) : '[]',
      c.lastUpdated || null
    );
  }

  fs.renameSync(OLD_WATCHLIST_FILE, OLD_WATCHLIST_FILE + '.bak');
  console.log(`\n📦  Migrace watchlistu: ${cards.length} karet importováno.`);
  console.log(`    Heslo pro přístup: "${MIGRATION_PASSWORD}"\n`);
}

/* ─── Auth helpers ───────────────────────────────────────────────────────── */

function passwordToId(password) {
  return crypto.createHash('sha256').update(password).digest('hex').slice(0, 32);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function requireWatchlist(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (payload.role !== 'watchlist') return res.status(403).json({ error: 'Forbidden' });
    req.watchlistId = payload.watchlistId;
    next();
  } catch {
    res.status(401).json({ error: 'Neplatný nebo expirovaný token' });
  }
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
  } catch {
    res.status(401).json({ error: 'Neplatný nebo expirovaný token' });
  }
}

/* ─── Pre-Modern legální edice ───────────────────────────────────────────── */

const PREMODERN_EDITIONS = [
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
  '4th Edition', 'Fourth Edition',
  '5th Edition', 'Fifth Edition',
  '6th Edition', 'Sixth Edition', 'Classic Sixth',
  '7th Edition', 'Seventh Edition',
  'Ice Age', 'Chronicles', 'Homelands', 'Alliances',
  'Mirage', 'Visions', 'Weatherlight',
  'Tempest', 'Stronghold', 'Exodus',
  "Urza's Saga", "Urza's Legacy", "Urza's Destiny",
  'Mercadian Masques', 'Nemesis', 'Prophecy',
  'Invasion', 'Planeshift', 'Apocalypse',
  'Odyssey', 'Torment', 'Judgment',
  'Onslaught', 'Legions', 'Scourge',
];

const EDITION_LABELS = [
  '3rd Edition', 'Alliances', 'Alpha', 'Antiquities', 'Apocalypse',
  'Arabian Nights', 'Asian Black Bordered', 'Beta', 'Chronicles',
  'Classic Sixth Edition', 'Exodus', 'Fallen Empires', 'Fifth Edition',
  'Foreign Black Bordered', 'Fourth Edition', 'Homelands', 'Ice Age',
  'Invasion', 'Judgment', 'Legends', 'Legends Italian', 'Legions',
  'Mercadian Masques', 'Mirage', 'Nemesis', 'Odyssey', 'Onslaught',
  'Planeshift', 'Prophecy', 'Revised', 'Scourge', 'Seventh Edition',
  'Stronghold', 'Tempest', 'The Dark', 'Torment', 'Unlimited',
  "Urza's Destiny", "Urza's Legacy", "Urza's Saga", 'Visions', 'Weatherlight',
];

function normalizeApos(s) {
  return (s || '').replace(/[\u00B4\u2018\u2019\u02BC`]/g, "'");
}

function isPremodern(edition) {
  const e = normalizeApos(edition).toLowerCase().trim();
  return PREMODERN_EDITIONS.some(pat => {
    const p = normalizeApos(pat).toLowerCase().trim();
    return e === p || (e.startsWith(p) && (e.length === p.length || /\W/.test(e[p.length])));
  });
}

/* ─── CR scraper ─────────────────────────────────────────────────────────── */

function extractCardsFromPage(page) {
  return page.evaluate(() => {
    const allRows = Array.from(document.querySelectorAll('tr'));
    const cards   = [];

    // New CR structure (2026):
    //   row A (3 cells): card name in cells[1]
    //   row B (2 cells): edition in cells[0], card type in cells[1]
    //   row C (4 cells): rarity in cells[0], qty in cells[1], price in cells[2]
    let pendingName    = null;
    let currentName    = '';
    let currentEdition = '–';

    for (let i = 0; i < allRows.length; i++) {
      const cells = Array.from(allRows[i].querySelectorAll('td'));

      // Row A – card name
      if (cells.length === 3) {
        const t = (cells[1].innerText || '').replace(/\s+/g, ' ').trim();
        if (t && t.length > 1 && t.length <= 100) pendingName = t;
        continue;
      }

      // Row B – edition (only valid when following a name row)
      if (cells.length === 2 && pendingName !== null) {
        const ed = (cells[0].innerText || '').replace(/\s+/g, ' ').trim();
        if (ed && ed.length > 1 && ed.length <= 80) {
          currentName    = pendingName;
          currentEdition = ed;
        }
        pendingName = null;
        continue;
      }

      // Any non-2-cell row resets pendingName
      if (cells.length !== 2) pendingName = null;

      // Row C – price / qty
      if (cells.length !== 4) continue;
      const rowText = allRows[i].innerText || '';
      if (!rowText.includes('Kč') || !rowText.includes('ks')) continue;

      const priceM = (cells[2].innerText || '').match(/([\d\s]+)\s*Kč/);
      if (!priceM) continue;
      const price = parseInt(priceM[1].replace(/\s/g, ''), 10);
      if (!price) continue;

      const qtyM    = (cells[1].innerText || '').match(/(\d+)\s*ks/i);
      const quantity = qtyM ? parseInt(qtyM[1], 10) : 0;

      if (!currentName) continue;
      cards.push({ name: currentName, edition: currentEdition, price, quantity });
    }

    return cards;
  });
}

async function searchAllPages(page, q, maxPages = Infinity, sortBy = 'ceny') {
  const PAGE_SIZE = 30;
  const firstUrl  = `https://www.cernyrytir.cz/index.php3?akce=3&jmenokarty=${encodeURIComponent(q)}&edice_magic=0&triditpodle=${sortBy}&submit=Vyhledej`;
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

  for (let p = 2; p <= Math.min(totalPages, maxPages); p++) {
    const offset  = (p - 1) * PAGE_SIZE;
    const nextUrl = `https://www.cernyrytir.cz/index.php3?akce=3&limit=${offset}&jmenokarty=${encodeURIComponent(q)}&edice_magic=libovolna&poczob=${PAGE_SIZE}&triditpodle=${sortBy}&hledej_pouze_magic=1&submit=Vyhledej`;
    await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    for (const c of await extractCardsFromPage(page)) {
      const key = `${c.name}|${c.edition}|${c.price}`;
      if (!seen.has(key)) { seen.add(key); allCards.push(c); }
    }
  }

  return allCards;
}

/* ─── Najada API ─────────────────────────────────────────────────────────── */

const NAJADA_GAME_ID = '40e972fe-c136-4d66-b61a-89f6be0f93d5';

async function searchNajada(query) {
  const url = `https://najada.games/api/v1/najada2/catalog/mtg-singles/` +
    `?expansion__game=${NAJADA_GAME_ID}&o=price&in_stock=false` +
    `&q=${encodeURIComponent(query)}&article_price_min=0&article_price_max=10000000&limit=200&offset=0`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json', 'Referer': 'https://www.najada.games/' },
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
        return all.filter(c => isPremodern(c.edition)).map(c => ({ ...c, condition: '–', shop: 'Černý Rytíř' }));
      } finally {
        if (browser) await browser.close();
      }
    })());
  }

  if (shops.includes('najada')) tasks.push(searchNajada(q));

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

app.get('/api/editions', (_req, res) => res.json(EDITION_LABELS));


/* ─── Watchlist auth endpoints ───────────────────────────────────────────── */

app.post('/api/watchlist/create', async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: 'Heslo musí mít alespoň 4 znaky' });

  const count = db.prepare('SELECT COUNT(*) as c FROM watchlists').get().c;
  if (count >= MAX_WATCHLISTS) return res.status(429).json({ error: `Maximální počet watchlistů (${MAX_WATCHLISTS}) byl dosažen` });

  const id       = passwordToId(password);
  const existing = db.prepare('SELECT id FROM watchlists WHERE id = ?').get(id);
  if (existing) return res.status(409).json({ error: 'Watchlist s tímto heslem již existuje – použij "Otevřít existující".' });

  const hash = await bcrypt.hash(password, 10);
  db.prepare('INSERT INTO watchlists (id, password_hash, password_plain) VALUES (?, ?, ?)').run(id, hash, password);

  const token = jwt.sign({ watchlistId: id, role: 'watchlist' }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

app.post('/api/watchlist/login', async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Chybí heslo' });

  const id = passwordToId(password);
  const wl = db.prepare('SELECT * FROM watchlists WHERE id = ?').get(id);
  if (!wl) return res.status(401).json({ error: 'Watchlist nenalezen – zkontroluj heslo nebo vytvoř nový.' });

  const match = await bcrypt.compare(password, wl.password_hash);
  if (!match) return res.status(401).json({ error: 'Watchlist nenalezen – zkontroluj heslo nebo vytvoř nový.' });

  db.prepare("UPDATE watchlists SET last_accessed = datetime('now') WHERE id = ?").run(id);
  const token = jwt.sign({ watchlistId: id, role: 'watchlist' }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

/* ─── Watchlist CRUD (protected) ─────────────────────────────────────────── */

function dbCardsToList(rows) {
  return rows.map(r => ({
    ...r,
    cr_articles    : r.cr_articles     ? JSON.parse(r.cr_articles)     : [],
    najada_articles: r.najada_articles ? JSON.parse(r.najada_articles) : [],
  }));
}

app.get('/api/watchlist', requireWatchlist, (req, res) => {
  res.json(dbCardsToList(
    db.prepare('SELECT * FROM watchlist_cards WHERE watchlist_id = ? ORDER BY rowid').all(req.watchlistId)
  ));
});

app.post('/api/watchlist/add', requireWatchlist, (req, res) => {
  const { name, edition } = req.body || {};
  if (!name || !edition) return res.status(400).json({ error: 'Chybí name nebo edition' });
  const id = genId();
  db.prepare('INSERT INTO watchlist_cards (id, watchlist_id, name, edition) VALUES (?, ?, ?, ?)').run(id, req.watchlistId, name.trim(), edition.trim());
  res.json({ id, watchlist_id: req.watchlistId, name: name.trim(), edition: edition.trim(), cr_price: null, cr_quantity: null, najada_articles: [] });
});

app.post('/api/watchlist/add-bulk', requireWatchlist, (req, res) => {
  const { name, editions } = req.body || {};
  if (!name || !Array.isArray(editions) || editions.length === 0)
    return res.status(400).json({ error: 'Chybí name nebo editions' });
  const insert = db.prepare('INSERT INTO watchlist_cards (id, watchlist_id, name, edition) VALUES (?, ?, ?, ?)');
  for (const edition of editions) {
    if (!edition) continue;
    insert.run(genId(), req.watchlistId, name.trim(), edition.trim());
  }
  res.json({ list: dbCardsToList(db.prepare('SELECT * FROM watchlist_cards WHERE watchlist_id = ? ORDER BY rowid').all(req.watchlistId)) });
});

app.post('/api/watchlist/import', requireWatchlist, (req, res) => {
  const { cards } = req.body || {};
  if (!Array.isArray(cards) || cards.length === 0)
    return res.status(400).json({ error: 'Chybí cards' });

  const insert = db.prepare('INSERT INTO watchlist_cards (id, watchlist_id, name, edition) VALUES (?, ?, ?, ?)');
  let added = 0;
  for (const card of cards) {
    const { name, edition } = card;
    if (!name || !edition) continue;
    try { insert.run(genId(), req.watchlistId, name.trim(), edition.trim()); added++; }
    catch (e) { console.error('Import skip:', e.message); }
  }

  res.json({
    added,
    list: dbCardsToList(db.prepare('SELECT * FROM watchlist_cards WHERE watchlist_id = ? ORDER BY rowid').all(req.watchlistId))
  });
});

app.delete('/api/watchlist/all', requireWatchlist, (req, res) => {
  db.prepare('DELETE FROM watchlist_cards WHERE watchlist_id = ?').run(req.watchlistId);
  db.prepare('DELETE FROM watchlists WHERE id = ?').run(req.watchlistId);
  res.json({ ok: true });
});

app.patch('/api/watchlist/:id/qty', requireWatchlist, (req, res) => {
  const qty = parseInt(req.body?.qty_needed, 10);
  if (!Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: 'Neplatné množství' });
  db.prepare('UPDATE watchlist_cards SET qty_needed = ? WHERE id = ? AND watchlist_id = ?')
    .run(qty, req.params.id, req.watchlistId);
  res.json({ ok: true });
});

app.delete('/api/watchlist/:id', requireWatchlist, (req, res) => {
  db.prepare('DELETE FROM watchlist_cards WHERE id = ? AND watchlist_id = ?').run(req.params.id, req.watchlistId);
  res.json({ ok: true });
});

app.post('/api/watchlist/refresh', requireWatchlist, async (req, res) => {
  const rows = db.prepare('SELECT * FROM watchlist_cards WHERE watchlist_id = ?').all(req.watchlistId);
  if (rows.length === 0) return res.json([]);

  const najadaSettled = await Promise.allSettled(rows.map(r => searchNajada(r.name)));

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx        = await browser.newContext({ userAgent: USER_AGENT });
    const page       = await ctx.newPage();
    const updateCard = db.prepare(
      'UPDATE watchlist_cards SET cr_price=?, cr_quantity=?, cr_articles=?, najada_articles=?, last_updated=? WHERE id=?'
    );

    for (let i = 0; i < rows.length; i++) {
      const row      = rows[i];
      const entryEd  = normalizeApos(row.edition).toLowerCase();
      const baseName = normalizeApos(row.name).toLowerCase().trim();

      const edMatch = c => {
        const cardEd = normalizeApos(c.edition).toLowerCase();
        return cardEd.includes(entryEd) || entryEd.includes(cardEd);
      };

      // CR název musí být přesně baseName nebo baseName + " - <condition>"
      const nameMatch = c => {
        const cn = normalizeApos(c.name).toLowerCase();
        if (!cn.startsWith(baseName)) return false;
        if (cn.length === baseName.length) return true;       // přesná shoda
        return cn.slice(baseName.length).startsWith(' - ');   // jen condition suffix
      };

      let cr_price = null, cr_quantity = null, cr_articles = [];
      try {
        const crAll     = await searchAllPages(page, row.name, 8, 'jmeno');
        const crMatched = crAll.filter(c => nameMatch(c) && edMatch(c))
                               .sort((a, b) => a.price - b.price);
        cr_articles = crMatched.map(a => ({ name: a.name, price: a.price, quantity: a.quantity }));
        // Backward compat – ulož i best (první in-stock nebo nejlevnější)
        const best  = crMatched.find(c => c.quantity > 0) || crMatched[0] || null;
        cr_price    = best ? best.price    : null;
        cr_quantity = best ? best.quantity : null;
      } catch (e) {
        console.error(`[refresh] CR chyba pro "${row.name}":`, e.message);
      }

      let najada_articles = [];
      if (najadaSettled[i].status === 'fulfilled') {
        const cards    = najadaSettled[i].value.filter(edMatch);
        const inStock  = cards.filter(c => c.quantity > 0).sort((a, b) => a.price - b.price);
        const fallback = !inStock.length ? cards.sort((a, b) => a.price - b.price).slice(0, 1) : [];
        najada_articles = (inStock.length ? inStock : fallback).map(a => ({
          price: a.price, quantity: a.quantity, condition: a.condition,
        }));
      }

      updateCard.run(cr_price, cr_quantity, JSON.stringify(cr_articles), JSON.stringify(najada_articles), new Date().toISOString(), row.id);
    }

    res.json(dbCardsToList(
      db.prepare('SELECT * FROM watchlist_cards WHERE watchlist_id = ? ORDER BY rowid').all(req.watchlistId)
    ));
  } catch (err) {
    console.error('[refresh] Chyba:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

/* ─── Admin endpoints ────────────────────────────────────────────────────── */

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Nesprávné heslo' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

app.get('/api/admin/watchlists', requireAdmin, (_req, res) => {
  res.json(db.prepare(`
    SELECT w.id, w.password_plain, w.created_at, w.last_accessed, COUNT(c.id) as card_count
    FROM watchlists w
    LEFT JOIN watchlist_cards c ON c.watchlist_id = w.id
    GROUP BY w.id ORDER BY w.created_at DESC
  `).all());
});

app.delete('/api/admin/watchlists/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM watchlist_cards WHERE watchlist_id = ?').run(req.params.id);
  db.prepare('DELETE FROM watchlists WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ─── Start ──────────────────────────────────────────────────────────────── */

migrateOldWatchlist().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🔍  Premodern  →  http://localhost:${PORT}`);
    console.log(`🔧  Admin      →  http://localhost:${PORT}/admin.html\n`);
  });
});
