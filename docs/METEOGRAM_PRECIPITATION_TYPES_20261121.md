# Meteogram: rozpoznawanie rodzaju opadu (21.11.2026)

## Zakres
Kolory słupków w panelu **Opad / wilgotność** zależą od rodzaju zjawiska. Wąski pasek nad osią opadów oznacza rodzaj dla każdej godziny. Przy odpowiednim powiększeniu pojawia się kod w godzinie; węższe widoki zachowują kolor, a dokładny opis jest w dymku kursora i panelu po dotknięciu. Natężenie opadu (mm/h), RH, istniejące linie prawdopodobieństwa i pozostałe panele nie zmieniają wartości.

Źródłem klasyfikacji jest przede wszystkim modelowy kod zjawiska `weather_code` WMO/Open-Meteo. Pomocniczo odczytywane są `rain` (mm), `showers` (mm) i `snowfall` (cm). Składowe **nie są sumowane** — śnieg ma inne jednostki. Kody kategorii pogodowej nie są interpolowane liniowo między terminami; wybierany jest najbliższy kod źródłowy.

## Rodzaje
- DZ, FZDZ: mżawka i mżawka marznąca (WMO 51–57).
- RA, FZRA: deszcz i deszcz marznący (61–67).
- SN, SG, PL: śnieg, śnieg ziarnisty, ziarna lodowe (71–79).
- RASN: współwystępujące składowe deszczu i śniegu, a nie niezgodność modeli.
- SHRA, SHSN, SHRASN: opady przelotne (80–86, składowe `showers`).
- SHGS (87/88): drobny grad albo krupy śnieżne — kod nie rozdziela tych dwóch rodzajów.
- SHGR (89/90): grad w przelotnych opadach.
- TS, TSRA, TSSN, TSGR: burza (95–99); przy WMO 96/99 model wskazuje grad, ale **nie pozwala określić jego rozmiaru**.
- PCP: model prognozuje opad, ale jego rodzaju nie da się ustalić.
- VAR: modele nie są zgodne co do rodzaju. Przykładowo RA w 50% i SN w 50% nie może automatycznie dawać RASN.

## Konsensus i ostrożność
W konsensusie wykorzystywane są aktualne wagi modeli i adaptacyjny mnożnik dla opadu. Szczegóły zawierają dominujący typ, udział wagowy modeli z tym typem (wśród modeli sygnalizujących zjawisko), udział wagowy modeli wskazujących zjawisko w całym zbiorze oraz alternatywy i sygnał gradu.

Nie wprowadzamy sztucznego gradu na podstawie samego CAPE ani nie rozpoznajemy śniegu wyłącznie z temperatury przy powierzchni. Występowanie gradu z radaru wymaga osobnej walidacji obserwacyjnej i nie jest automatycznie przenoszone do godzin odległej prognozy. Typ prezentowany jest jako prognoza modelowa, **nie obserwacja** ani zatwierdzony kod TAF.

## Rozszerzenie radarowo-konwekcyjne
- `meteogram-precipitation-evidence.js` odczytuje tylko świeże, lokalne snapshoty `prognozaepir.taf.radar-evidence.v1` (POLRAD, maks. 45 min od klatki) i `prognozaepir.convection12h.v1` (prognoza NWP, maks. 2 h od zapisu).
- Punkt musi odpowiadać EPIR. Dla POLRAD wymagana jest pewność wektora ≥55/100 oraz wspierający model, a prognoza ruchu echa jest używana tylko w horyzoncie 0–3 h.
- TCu/Cb/TS z konwekcji służą jako sygnał wspomagający. Nie zamieniają automatycznie RA w SHRA ani nie potwierdzają TS, CB czy gradu.
- Turkusowy romb oznacza zgodny sygnał modelowy i prognozowaną adwekcję echa. Pomarańczowy romb oznacza wyłącznie modelowy sygnał konwekcji.
- Dymki i karta szczegółów podają źródła oraz świeżość danych. Po przekroczeniu maksymalnego wieku snapshotów sygnał nie jest wykorzystywany; bez danych radarowych działa klasyfikacja modelowa.
- Moduł nie pobiera radarów ani nie zmienia prognozy TAF: obsługuje istniejącą wymianę danych między kartami przeglądarki i nie wymaga nowego źródła zewnętrznego.

## Pliki i QA
- `meteogram-precipitation-types.js`: kody, ważenie konsensusu, dane do dymków i oznaczenia godzin.
- `index.html`: dodatkowe pola źródłowe i bezpieczne próbkowanie kodów WMO.
- `meteogram-layout-v2.js`, `meteogram-visfog-split.js`: kolorowanie słupków.
- `meteogram-visfog-cleanup.js`, `visual-style-fix.js`: legenda oraz wskazania kursora.
- `scripts/prepare_pages.py`: ładowanie modułu po pozostałych nakładkach wykresu.

Lokalny test: `node tests/meteogram-precipitation-types.test.js`. Dodatkowo należy otworzyć wynik `python scripts/prepare_pages.py` i ręcznie sprawdzić: widoki 48/72/120 h, konsensus/pojedynczy model, jasny/ciemny motyw, zoom, kursory i dotyk, przewijanie przy zmianie modelu, kody WMO podczas zmiany fazy opadu oraz fallback na brak danych. Nie uruchamiać automatycznego deploymentu bez testów.
