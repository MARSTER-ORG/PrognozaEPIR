# Analiza archiwów EPIR 2020–2024 dla Fog Engine vNext — korekta v2

## Przyjęta definicja etykiety mgły

Dla potrzeb historycznego uczenia przyjmujemy od teraz twardą regułę projektu:

**mgła = jawny kod mgły (`FG`, `FZFG`, `BCFG`, `PRFG`) LUB widzialność <1000 m bez opadu.**

Brak kodu `FG` nie jest więc wymagany, jeżeli raport podaje widzialność poniżej 1000 m i nie występuje opad. Jednocześnie sam opad z widzialnością <1000 m nie jest automatycznie nazywany mgłą; jeżeli w takiej depeszy występuje jawny `FG/FZFG/...`, nadal jest to mgła.

`MIFG` i `BR` pozostają osobnymi stanami. Jeżeli jednak raport bez opadu ma widzialność <1000 m, dla targetu wystąpienia mgły otrzymuje `fog_truth=true` niezależnie od braku kodu FG.

## Wpływ tej reguły na dane 2020–2024

W 67 770 znormalizowanych METAR/SPECI znaleziono:

- **774** obserwacji z widzialnością <1000 m bez opadu,
- **771** z nich miało już jawny kod mgły,
- **3** obserwacje nie miały poprawnie rozpoznanego kodu mgły, ale zgodnie z regułą są traktowane jako mgła,
- łącznie **871** obserwacji ma `fog_truth=true` po połączeniu kodów jawnych i reguły widzialności.

Te trzy dodatkowe rekordy to:

- `2022-03-03T06:00:00Z` — `METAR EPIR 030600Z 33004KT 0600 FZGF OVC003 M03/M03 Q1019 RMK M031 100 8/8=`
- `2022-10-26T04:00:00Z` — `METAR EPIR 260400Z 24006KT 0200 VV001 09/09 Q1018 RMK 094 098 ///=`
- `2023-10-10T06:30:00Z` — `METAR EPIR 100630Z 18004KT 0100 VV001 02/01 Q1020 RMK 017 096 ///=`

Pierwszy z nich zawiera `FZGF`, co wygląda jak literówka `FZFG`; dwa pozostałe mają bardzo niską widzialność i `VV001`, lecz brak jawnego kodu FG. Reguła widzialności zabezpiecza dataset również przed takimi przypadkami.

## Zdarzenia po korekcie

Liczba niezależnych zdarzeń **nie zmienia się**: pozostaje **485**, w tym **129 zdarzeń z mgłą**. Powód: trzy rekordy z reguły widzialności leżą w zdarzeniach, które i tak zawierają jawny FG później lub wcześniej. Reguła poprawia jednak dokładny stan i w jednym przypadku przesuwa rozpoznany początek mgły wcześniej.

Pierwszy stan 485 zdarzeń po ujednoliceniu etykiet:

- BR: **323**,
- MIFG: **84**,
- FG/fog-truth: **78**.

Dla 129 zdarzeń zawierających mgłę:

- **78** zaczyna się już stanem FG/fog-truth,
- **44** zaczyna się od BR,
- **7** zaczyna się od MIFG.

Poprzednia kategoria `VIS_FOG` zostaje usunięta — zgodnie z przyjętą regułą jest to po prostu **FG/fog-truth**.

Po ponownym przeliczeniu przejść na ujednoliconych stanach liczba zdarzeń zawierających co najmniej jedno przejście wynosi:

- BR → FG: **56** zdarzeń,
- MIFG → FG: **7** zdarzeń,
- BR → MIFG: **3** zdarzenia.

Wcześniejsza liczba 46 dla BR → FG wynikała z bardziej zachowawczej logiki przejść; po zastosowaniu jednej kanonicznej etykiety `fog_truth` właściwa liczba zdarzeń z przejściem BR → FG wynosi 56.

## Korekta wcześniejszego wniosku o godzinach 04–05 UTC

W poprzedniej analizie liczba **90** została opisana zbyt szeroko jako „pierwszy jawny FG o 04–05Z”. To było nieprecyzyjne.

Po ponownym policzeniu:

- **90** zdarzeń zawierających FG ma początek całego zdarzenia rodziny `BR/MIFG/FG` w godzinach 04–05Z,
- **82** zdarzenia mają **pierwszą rzeczywistą etykietę mgły (`fog_truth`)** w godzinach 04–05Z.

To rozróżnienie jest ważne: część zdarzeń rozpoczyna się wcześniej lub w tym samym oknie od BR/MIFG, a dopiero później przechodzi do FG.

## Cenzurowanie nocnego onsetu nadal pozostaje problemem

Reguła `<1000 m + brak opadu = mgła` poprawia etykietowanie tam, gdzie widzialność jest podana. Nie rozwiązuje jednak raportów nocnych AUTO, w których **widzialności w ogóle nie ma**. Takiego raportu nadal nie wolno oznaczać jako `CLEAR`.

W aktualnej analizie pokrycia **88 z 129 zdarzeń zawierających FG** ma flagę potencjalnego lewostronnego cenzurowania onsetu. Dlatego do modelu czasu powstania mgły nadal właściwy jest target przedziałowy/hazard, a nie ślepe użycie czasu pierwszego kodu FG.

## Konsekwencje dla Fog Engine

1. `fog_truth` jest nadrzędną etykietą do uczenia wystąpienia mgły.
2. `FG code` i `visibility<1000/no precip` są dwiema drogami potwierdzenia tego samego targetu.
3. `MIFG` i `BR` pozostają osobnymi stanami przejściowymi/targetami.
4. Nocny AUTO bez widzialności pozostaje `UNKNOWN`, nie `CLEAR`.
5. Dla onsetu używamy najwcześniejszego `fog_truth`, a gdy poprzedzający okres jest niewiarygodny — przedziału cenzurowanego.
6. Reguła widzialności powinna zostać zastosowana identycznie do danych 2025–2026 oraz w każdym przyszłym backteście legacy/new/hybrid engine.

## Pliki v2

- `aviation_observations_2020_2024.jsonl` — dodane `fog_truth`, `fog_truth_source`, `fog_visibility_rule`,
- `fog_events_2020_2024.csv` — `VIS_FOG` ujednolicone do `FG`,
- `fog_events_censored_2020_2024.csv` — jak wyżej, z zachowanymi flagami cenzurowania,
- `label_policy_summary.json` — dokładne statystyki po korekcie,
- `synop_teacher_2020_2024.jsonl` — bez zmian,
- `inventory_2020_2024.json` — bez zmian.
