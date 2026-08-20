# Premodern (cr-search)

Vyhledávač premodern MTG karet napříč českými eshopy (Černý Rytíř, Najáda) s watchlistem, který hlídá ceny a dostupnost. Běží na www.premodern.cz. Uživatel projektu není programátor – vysvětlovat česky a stručně.

## Struktura

| Soubor | Co obsahuje |
|---|---|
| `server.js` | Všechen backend: Express endpointy, SQLite, JWT auth, admin, `CHANGELOG` a `KNOWN_ISSUES`, seznam `PREMODERN_EDITIONS`, klient Najády |
| `cr-api.js` | Klient veřejného API Černého Rytíře. Samostatně spustitelný test: `node cr-api.js "Ancient Tomb"` |
| `public/index.html` | Celý frontend v jednom souboru – HTML, CSS i JS, bez frameworku a bez build stepu |
| `public/admin.html` | Admin panel (`/admin.html`), přehled a mazání watchlistů |
| `data/cr-search.db` | SQLite databáze (watchlisty a karty) |

## Vývoj

```bash
npm start          # http://localhost:3000
```

`.env` podle `.env.example`: `JWT_SECRET`, `ADMIN_PASSWORD`, `MAX_WATCHLISTS`, `PORT`.

Projekt nemá automatické testy. Změny se ověřují ručně přes API:

```bash
curl "http://localhost:3000/api/search?q=Ancient%20Tomb&shops=cr"
```

Watchlist se testuje přes `POST /api/watchlist/create` (heslo = identita watchlistu), `add` a `refresh` s `Authorization: Bearer <token>`. Testovací watchlist po sobě uklízet přes `DELETE /api/watchlist/all`.

## Konvence

- **Každá změna = nová verze** v poli `CHANGELOG` v `server.js`, česky, nahoře. Vyřešené položky se odstraňují z `KNOWN_ISSUES`.
- Uživatelské texty jsou české, kód a komentáře taky.
- Frontend drží zavedený styl: žádné závislosti, žádný build, template stringy a `esc()` na vkládaná data.
- Eshopové výsledky mají jednotný tvar `{ name, edition, price, quantity, condition, foil, shop }`; filtr premodern edic dělá `isPremodern()`.

## Nasazení

fly.io, app `premodern`. Deploy z složky projektu (`flyctl deploy`), pak `flyctl status -a premodern`.

**Musí běžet přesně jedna machine** – databáze je SQLite na fly volume, druhá instance by měla vlastní kopii dat a watchlisty by uživatelům mizely. Případně srovnat `flyctl scale count 1 -a premodern`.
