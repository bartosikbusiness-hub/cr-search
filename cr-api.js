// cr-api.js – modul Černý Rytíř (v4.2)
// Přímé volání API eshop-api.cernyrytir.eu – bez Playwrightu, bez browseru.
//
// Použití v server.js:   const { searchCardCR } = require('./cr-api');
//                        const varianty = await searchCardCR('Ancient Tomb');
//
// Samostatný test:       node cr-api.js "Ancient Tomb"

const CR_CARD_LIST_URL =
  'https://eshop-api.cernyrytir.eu/api/public/card/list?eshop_mode=STANDARD';

const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Origin': 'https://cernyrytir.cz',
  'Referer': 'https://cernyrytir.cz/',
};

const ROWS_PER_PAGE = 500; // ověřeno: API vrátí i 1585 řádků v jednom requestu
const MAX_PAGES = 8;       // pojistka proti nekonečné smyčce (max 4000 karet)

/** Prázdný filtr přesně podle toho, co posílá web CR. */
function buildFilter(cardName) {
  return {
    inStockOnly: false,
    foil: { regular: false, foil: false, etched: false },
    rarity: {
      common: false, uncommon: false, rare: false, special: false,
      mythic: false, bonus: false, token: false, land: false,
    },
    condition: { nm: false, lp: false, pl: false },
    color: {
      white: false, blue: false, black: false, red: false, green: false,
      colorless: false, multicolor: false, colorCombination: false,
      onlySelectedColors: false,
    },
    price: { min: 0, max: 0 },
    typeLine: {
      artifact: false, battle: false, creature: false, enchantment: false,
      instant: false, land: false, sorcery: false, planeswalker: false,
    },
    cardName,
  };
}

/** Normalizace jména pro exact-match: lowercase, bez suffixu "(123)", jen přední strana DFC. */
function normalizeName(name) {
  return (name || '')
    .replace(/[´‘’ʼ`]/g, "'") // sjednocení apostrofů (Urza's …)
    .toLowerCase()
    .split('//')[0]
    .replace(/\s*\(\d+\)\s*$/, '')
    .trim();
}

async function fetchCardListPage(cardName, page) {
  const body = {
    extendedFilter: buildFilter(cardName),
    pagination: {
      page,
      rowsPerPage: ROWS_PER_PAGE,
      rowsNumber: 0,
      sortBy: 'PRICE',
      descending: true,
    },
  };
  const res = await fetch(CR_CARD_LIST_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`CR API vrátilo HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Vyhledá kartu na Černém Rytíři přes nové API.
 * @param {string} cardName – přesný název karty (např. "Lightning Bolt")
 * @param {object} [opts]
 * @param {boolean} [opts.exactOnly=true] – vrátit jen přesné shody názvu
 * @returns {Promise<Array>} pole variant:
 *   { name, edition, editionId, rarity, collectorNumber,
 *     foil: 'REGULAR'|'FOIL'|'ETCHED', condition: 'NM'|'LP'|'PL',
 *     language, price, buyPrice, stock, productUid, scryfallId }
 */
async function searchCardCR(cardName, { exactOnly = true } = {}) {
  const target = normalizeName(cardName);
  const results = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    let data;
    try {
      data = await fetchCardListPage(cardName, page);
    } catch (err) {
      // Graceful degradace – nesundávat celý refresh kvůli CR
      if (page === 1) throw err;
      break;
    }

    const list = Array.isArray(data.list) ? data.list : [];
    if (!list.length) break;

    for (const card of list) {
      if (exactOnly && normalizeName(card.name) !== target) continue;

      for (const ic of card.internalCards || []) {
        results.push({
          name: card.name,
          edition: card.cardEditionName || '',
          editionId: card.cardEditionId ?? null,
          rarity: card.rarity || '',
          collectorNumber: card.collectorNumber || '',
          foil: ic.foil || 'REGULAR',
          condition: ic.condition || '',
          language: ic.language || '',
          price: ic.priceSell ?? null,
          buyPrice: ic.priceBuy ?? null,
          stock: ic.availEshopQty ?? 0,
          productUid: ic.productUid || '',
          scryfallId: card.scryfallId || '',
        });
      }
    }

    const total = data.pagination?.rowsNumber ?? 0;
    if (total && page * ROWS_PER_PAGE >= total) break;
    if (list.length < ROWS_PER_PAGE) break;
  }

  return results;
}

module.exports = { searchCardCR, normalizeName };

// ── Samostatný test: node cr-api.js "Název karty" ─────────────────────────
if (require.main === module) {
  const card = process.argv[2] || 'Lightning Bolt';
  (async () => {
    console.log(`▶ Hledám "${card}" na Černém Rytíři (přímé API) …`);
    const t0 = Date.now();
    const rows = await searchCardCR(card);
    const ms = Date.now() - t0;

    console.log(`✔ ${rows.length} variant za ${ms} ms\n`);
    for (const r of rows.slice(0, 25)) {
      const foil = r.foil === 'REGULAR' ? '' : ` [${r.foil}]`;
      console.log(
        `  ${r.edition.padEnd(26)} ${r.condition.padEnd(3)}${foil.padEnd(9)} ` +
        `${String(r.price).padStart(8)} Kč   sklad: ${r.stock} ks   (${r.language})`
      );
    }
    if (rows.length > 25) console.log(`  … a dalších ${rows.length - 25} variant`);
  })().catch((err) => {
    console.error('✖ Chyba:', err.message);
    process.exit(1);
  });
}