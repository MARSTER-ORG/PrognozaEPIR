# TAF Engine 2 — Instruction First

## Cel

`taf-engine-v2.js` jest jedynym komponentem odpowiedzialnym za reguły kodowania i dobór grup zmian TAF w PrognozaEPIR. Nadrzędnym źródłem reguł jest **Instrukcja opracowywania prognoz TAF, Edycja (A), 11.2023**. Dane modeli, METAR/SPECI, algorytmy probabilistyczne i późniejsze uczenie mogą zmieniać estymację meteorologiczną, ale nie mogą osłabiać ani omijać reguł instrukcji.

## Architektura

`taf-app-v2.js` pobiera dane z archiwum i ukrytego meteogramu, wybiera 12-godzinny cykl oraz przekazuje materiał wejściowy do `taf-engine-v2.js`. Aplikacja nie poprawia i nie przepisuje wygenerowanego TAF. Silnik wykonuje kolejno: zakotwiczenie bieżącą obserwacją, budowę stanów godzinowych, klasyfikację istotnych zmian, wybór BECMG/TEMPO/FM/PROB30, kodowanie TAF, normalizację oraz końcową walidację hard-gate. Jeżeli wynik narusza regułę twardą, silnik rzuca błąd i nie zwraca zaakceptowanej depeszy.

## Reguły przeniesione do jednego silnika

- `taf-generator-policy.js` → progi istotności, dobór grup zmian, CAVOK/NSC, widzialność, zachmurzenie, pogoda, wiatr.
- `taf-cloud-policy.js` → reguły warstw chmur, CB/TCU, progi pułapu i pełny opis warstw przy istotnej zmianie.
- `taf-weather-policy.js` → zasady opadów, FG/BR, zjawisk marznących, burz i NSW.
- `taf-gust-policy.js` → zasady porywów i kryteria istotnej zmiany wiatru.
- `taf-cavok-nsc-policy.js` → warunki CAVOK i NSC oraz pomijanie zwykłych chmur nieistotnych operacyjnie.
- `taf-instruction-guard.js` → końcowa walidacja hard-gate wewnątrz silnika.
- `taf-output-sanitizer.js` → jeden terminator `=` i normalizacja wyniku.
- `taf-hybrid-adapter.js` → zastąpiony przez `taf-app-v2.js`; adapter nie ma już prawa modyfikować wyniku po generacji.

Stare pliki mogą pozostać w repozytorium jako materiał historyczny/rollback, ale `taf.html` ich nie ładuje. Nie są częścią aktywnego toru generacji.

## Najważniejsze twarde zabezpieczenia

Silnik wymaga regularnego okresu 12 h i cyklu wydawanego 1 h przed początkiem ważności. Nie dopuszcza `PROB40`, `VV`, `MIFG/BCFG/PRFG`, więcej niż pięciu grup zmian, BECMG dłuższego niż 4 h ani porywu mniejszego niż średnia +10 KT. Kontroluje pełny stan po FM, poprawność użycia CAVOK oraz dokładnie jeden terminator `=`. Wartości widzialności i kryteria zmian wykorzystują progi 800/1500/3000/5000 m; pułap BKN/OVC progi 200/300/500/1000/1500 ft; reguły wiatru wykorzystują 60°, 10 KT i ograniczenie porywowe przy średniej co najmniej 15 KT.

## Wersja

- Engine: `2.0.0`
- Nazwa: `TAF Engine 2 — Instruction First`
- UI: `taf.html` + `taf-app-v2.js`
