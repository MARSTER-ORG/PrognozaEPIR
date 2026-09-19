# PrognozaEPIR — wspólny system UI

Od migracji `20260919-ui1` aktywne strony aplikacji korzystają z jednego pliku `app.css` i jednego kontrolera `theme.js`.

## Zasady

- `index.html` jest wzorcem kolorów, typografii, obramowań i podstawowych komponentów.
- Nie dodawaj nowych bloków `<style>` do plików HTML.
- Reguły specyficzne dla strony dopisuj do jej sekcji `EPIR-PAGE-START/END` w `app.css` i zawsze ograniczaj przez `html[data-epir-page="..."]`.
- Wspólne kolory bierz ze zmiennych w sekcji `EPIR-SHARED-START/END`; nie twórz osobnych palet jasnej/ciemnej dla podstron.
- `theme.js` przechowuje wybór `system / jasny / ciemny` w `localStorage`, synchronizuje starsze klucze motywu i buduje wspólną nawigację.
- Przy zmianie motywu wysyłane jest zdarzenie `prognozaepir:themechange`; meteogram na `canvas` jest dodatkowo przerysowywany.
- Logika meteorologiczna, modele, TAF, Fog Engine, radar i archiwum nie należą do warstwy UI i nie powinny być zmieniane przy edycji stylów.

## Strony objęte wspólnym UI

`index.html`, `fog.html`, `radar.html`, `sat-fog.html`, `lightning-alerts.html`, `taf.html`, `arch.html`.

## Kontrola

Workflow `.github/workflows/shared-ui-validation.yml` sprawdza przy zmianach UI:

- poprawność składni `theme.js` (`node --check`),
- brak bloków `<style>` w nagłówkach aktywnych stron,
- obecność `app.css` i `theme.js` na każdej stronie,
- prawidłowy `data-epir-page`,
- obecność sekcji strony i sekcji wspólnej w `app.css`.

Dzięki temu nowy styl nie powinien ponownie rozproszyć się po kodzie poszczególnych podstron.
