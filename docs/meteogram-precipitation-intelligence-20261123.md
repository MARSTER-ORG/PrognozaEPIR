# Meteogram PrognozaEPIR — inteligentne określanie charakteru opadów na podstawie chmur

Stan: 23.11.2026. Moduł `meteogram-precipitation-intelligence.js` jest dodatkową **ostrożną regułą modelowo-fizyczną**, a nie wytrenowanym i skalibrowanym klasyfikatorem ani bezpośrednią obserwacją rodzaju chmury.

## Podstawa meteorologiczna

WMO International Cloud Atlas rozróżnia:
- **St (Stratus)**: bardzo słabe opady, w tym mżawka, śnieg i śnieg ziarnisty; niska, płytka warstwa sprzyja mżawce, nie oznacza jednak automatycznie DZ.
- **Sc (Stratocumulus)**: często bez opadu, czasem bardzo słaba mżawka.
- **As / Ns (Altostratus / Nimbostratus)**: rozległe zachmurzenie warstwowe, przy Ns możliwy wielogodzinny deszcz lub śnieg.
- **Cu / Cb**: opady przelotne SHRA/SHSN, lokalne natężenia, przy Cb możliwe TS/GR. SHRA nie wymaga potwierdzenia Cb — wystarczy rozwinięta konwekcja Cu.
- O **fazie** opadu (RA/SN/RASN/FZRA/PL) decyduje w dużym stopniu pionowy profil termiczno-wilgotnościowy (T/Tw oraz ciepłe/zimne warstwy), nie sam rodzaj chmury czy temperatura przy gruncie.

Źródła odniesienia:
- [WMO — precipitation types and convective/stratiform clouds](https://cloudatlas.wmo.int/en/hydrometeors-falling-particles.html)
- [WMO — cloud identification guide (St, Ns, Cu, Cb)](https://cloudatlas.wmo.int/en/cloud-identification-guide.html)
- [UK Met Office — low-level clouds and drizzle](https://weather.metoffice.gov.uk/learn-about/weather/types-of-weather/clouds/low-level-clouds)
- [UK Met Office — mid-level clouds and precipitation](https://weather.metoffice.gov.uk/learn-about/weather/types-of-weather/clouds/mid-level-clouds)
- [NOAA — precipitation type and vertical thermal profile](https://vlab.noaa.gov/web/forecast-guide/fog?page=numerical-methods-for-determining-precipitation-type)
- [ECMWF — types of precipitation](https://confluence.ecmwf.int/spaces/FUG/pages/673550526/Section%2B2A.1.5.5%2BTypes%2Bof%2BPrecipitation)

## Jakie dane ma aplikacja

Aplikacja nie dostaje z Open-Meteo wprost klasyfikacji St/Ns/Sc. Ma natomiast godzinowo: poziomy zachmurzenia i wysokości geopotencjalne, zachmurzenie niskie/średnie, wysokości podstaw, wilgotność, temperaturę/punkt rosy, intensywność `RR`, kod WMO `weather_code` osobno dla modeli, niezależne TCu/Cb/TS (do +12 h), aktualny radar (tylko do +3 h) i wagi konsensusu.

Moduł wyznacza dlatego **proxy charakteru układu chmur**, z wyraźnym oznaczeniem „podobny do”:
- `shallow_stratiform`: niska, płytka warstwa (zachmurzenie niskie ≥80%, średnie ≤48%, podstawa do 1050 m), RH ≥89%, niewielki deficyt punktu rosy, słaby opad do 0,45 mm/h i niski udział burz.
- `deep_stratiform`: rozległe chmury niskie ≥77% i średnie ≥70%, RH ≥86%, opad co najmniej 0,45 mm/h, bez silnego sygnału burzowego.
- `convective_signal`: niezależne potwierdzenie radaru, TCu/Cb/TS lub konwekcji; chroni SH/TS przed sztucznym „wygładzaniem”.
- `insufficient` / `undetermined`: brak przekonujących danych; bez zmiany rodzaju opadu.

Wymagane są przynajmniej trzy rzeczywiste poziomy profilu chmur oraz komplet kluczowych parametrów. Brak danych jest `insufficient`, **nie** „brak chmur”.

## Kiedy wolno skorygować etykietę godziny

**Kandydat RA → DZ*** tylko, gdy przez trzy kolejne godziny utrzymuje się płytki, nasycony układ chmur; intensywność środkowej godziny ≤0,32 mm/h nie ma lokalnego maksimum; minimum dwa modele prognozują bezpośrednio DZ, a suma ich wag wśród modeli z opadem wynosi ≥28%; udział RA nie jest przeważający; sąsiednia godzina wskazuje DZ lub ma odrębne wsparcie DZ; co najmniej cztery modele prognostyczne wskazują opad; brak radaru/TCu/Cb i ryzyka fazy marznącej.

**Kandydat DZ → RA*** tylko, gdy przez trzy godziny panuje głębszy układ As/Ns-like, w obu godzinach sąsiednich wybrano RA, opad ma ≥0,6 mm/h w środkowej i ≥0,4 mm/h w sąsiednich; co najmniej dwa modele bezpośrednio wskazują RA, a ich waga stanowi ≥27% modelowych wskazań opadu; bez silnej konwekcji i bez dominującego DZ.

Dalsze zasady:
- Tylko prognozy do **48 h**, jedna odizolowana zmiana charakteru, przerwa godzinowa wyłącza korektę.
- Nie powstaje nowy opad, gdy `RR = 0`. Nie zmienia się ilość opadu, faza deszcz/śnieg, wartości poszczególnych modeli, surowy WMO `weather_code`, TAF ani prognoza burz.
- **Nigdy** nie przeklasyfikowujemy opadu marznącego, mieszanego, śniegu, gradu, burz ani niepewnego VAR na podstawie samych chmur.
- Przy `T ≤ 2,5°C` nie zmieniamy RA/DZ, ponieważ potrzebna byłaby ocena pionowego profilu T/Tw i ryzyka marznięcia.
- Gdy rzeczywisty silnik konwekcji/radar pokazuje zjawisko, pozostaje ono bez przeklasyfikowania.
- Obie korekty są **wyłącznie sugestiami opisu** na meteogramie i oznaczone gwiazdką: DZ* / RA*. W dymku podany jest kod źródłowy, udział modeli i uzasadnienie. Moduł jest odwracalny i ponawia ocenę przy każdej aktualizacji danych.
- Dotychczasowy ostrożny filtr 3-godzinnej ciągłości RA↔SHRA/SN↔SHSN działa **po** tej diagnozie i nadal chroni opady konwekcyjne.

Progi są heurystyczne i muszą zostać poddane historycznej walidacji oddzielnymi próbkami METAR/SPECI/SYNOP z rzeczywistym kodem DZ/RA; bez tego nie wolno przedstawiać ich jako skalibrowanej pewności numerycznej. Obecna nauka wag w trybie shadow pozostaje niezależna.

## Testy

- `node tests/meteogram-precipitation-intelligence.test.js`
- `node tests/meteogram-precipitation-types.test.js`
- `node tests/meteogram-precipitation-evidence.test.js`
- `node tests/meteogram-precipitation-continuity.test.js`
- `python3 scripts/prepare_pages.py`

CI GitHub Pages weryfikuje plik w artefakcie i testuje całość przed scaleniem.
