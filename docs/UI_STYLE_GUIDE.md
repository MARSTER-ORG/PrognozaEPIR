# PrognozaEPIR — wspólny system UI

Od migracji `20260919-ui1` aktywne strony aplikacji korzystają z jednego pliku `app.css` i jednego kontrolera `theme.js`.

## Zasady

- `index.html` jest wzorcem kolorów, typografii, obramowań i podstawowych komponentów.
- Nie dodawaj nowych bloków `<style>` do plików HTML.
- Reguły specyficzne dla strony dopisuj do jej sekcji `EPIR-PAGE-START/END` w `app.css` i zawsze ograniczaj przez `html[data-epir-page="..."]`.
- Wspólne kolory bierz ze zmiennych w sekcji `EPIR-SHARED-START/END`; nie twórz osobnych palet jasnej/ciemnej dla podstron.
- `theme.js` przechowuje wybór `system / jasny / ciemny` w `localStorage` i buduje wspólną nawigację.
- Logika meteorologiczna, modele, TAF, Fog Engine, radar i archiwum nie należą do warstwy UI i nie powinny być zmieniane przy edycji stylów.

## Kontrola

Uruchom:

```bash
python3 scripts/migrate-shared-ui.py --check
node --check theme.js
```

Migrator jest idempotentny: ponowne uruchomienie nie usuwa wcześniej przeniesionych sekcji CSS.
