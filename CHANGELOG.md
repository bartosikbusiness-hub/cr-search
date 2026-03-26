# Changelog – CR Search

## v3.3 (2026-03-26)
- Admin panel: nový sloupec **Heslo** zobrazuje plaintext heslo watchlistu
- DB migrace: přidán sloupec `password_plain` do tabulky `watchlists`
- Watchlisty vytvořené před touto verzí zobrazují `–` (heslo nebylo ukládáno)

## v3.2 (2026-03-26)
- Pojmenování watchlistu (volitelný název při vytváření)
- Multi-edition picker pro přidávání karet (výběr více edic najednou)
- Known Issues panel v UI

## v3.1 (2026-03-26)
- Import karet z Moxfieldu
- Scryfall auto-detekce edic při importu

## v2.5 (2026-03-26)
- Zelené zvýraznění řádku watchlistu pokud je karta skladem alespoň na jednom shopu

## v2.4 (2026-03-26)
- Watchlist zobrazuje všechny naskladněné kvality z Najády

## v2.3 (2026-03-26)
- Abecední řazení dropdown edic

## v2.2 (2026-03-26)
- Rozšíření edic: Alpha/Beta/Unlimited/Revised, Arabian Nights, Antiquities, Legends, The Dark, Fallen Empires, FBB/ABB
- Oprava isPremodern (startsWith matching)

## v1.0
- Základní CR Search: PreModern filter, vyhledávání, watchlist
