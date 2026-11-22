# PrognozaEPIR — spójność SHRA/SHSN a chmury Cu / TCu / Cb (22.11.2026)

## Podstawa meteorologiczna

Według Międzynarodowego Atlasu Chmur WMO opady przelotne występują z chmur konwekcyjnych typu **Cumulus lub Cumulonimbus**. `Cumulus congestus` (często określany TCu) może dawać opady przelotne także bez burzy. Natomiast kod SHRA sam w sobie nie dowodzi wystąpienia Cb ani nie pozwala automatycznie nadać kodu TCu. Kody chmur opisują postać chmury, kody zjawisk — charakter opadu.

Źródła:
- https://cloudatlas.wmo.int/en/hydrometeors-falling-particles.html
- https://cloudatlas.wmo.int/en/species-cumulus-congestus-cu-con.html
- https://weather.metoffice.gov.uk/learn-about/weather/types-of-weather/rain/rain-and-showers

## Przyczyny rozbieżności przed zmianą

1. `meteogram-precipitation-types.js` korzysta z `weather_code` (WMO 80–86) oraz składowej `showers` modeli; to diagnoza charakteru opadu.
2. `convection-horizon-12h.js` niezależnie, tylko na 0–12 h, wylicza heurystyczne wskaźniki TCu/Cb/TS z CAPE, LI, CIN i wybranych kodów NWP, przy czym wartości nie są skalibrowanymi prawdopodobieństwami bezpośredniej obserwacji chmur.
3. `meteogram-precipitation-evidence.js` dotychczas uznawał sygnał konwekcyjny głównie przy Cb ≥60% albo TS ≥55%, ignorując sam umiarkowany TCu. Nie przedstawiał też TCu w szczegółach.
4. Starszy moduł `meteogram-convection-dots-v2.js` istnieje w repo, ale nie jest aktywnym elementem strony. Nie przywracamy go, ponieważ zawiera także niepowiązane zmiany układu wykresu.

## Po zmianie

- Silnik konwekcji zapisuje liczbę modeli wskazujących pogodowy kod opadu przelotnego oraz liczbę rzeczywiście dostępnych parametrów termodynamicznych. Brak wejścia termodynamicznego nie oznacza braku konwekcji.
- Meteogram zestawia klasyfikację SHRA/SHSN/SHRASN z niezależnymi wskaźnikami `TCu`, `Cb`, `TS`, liczbą modeli i pokryciem danych. Brak prognozy poza horyzontem 12 h jest oznaczony jako **brak danych**, nie `TCu/Cb=0`.
- W dymku opadów przedstawiane są szacunkowe wartości TCu/Cb/TS, udział modeli wskazujących opad przelotny i ocena spójności:
  - **spójny sygnał NWP**: TCu lub Cb ≥40% z odpowiednią jakością danych,
  - **możliwy Cu bez TCu/Cb**: opad przelotny w co najmniej dwóch modelach przy niskich wskaźnikach rozwiniętych chmur, bez automatycznego zwiększania Cb,
  - **rozbieżność modeli**: SH/TS z konsensusu, ale brak opadu przelotnego w modelach silnika chmur i niskie wskaźniki, albo model burzy bez wyraźnego Cb,
  - **nierozstrzygnięte**: za mało modeli, danych termodynamicznych, zbyt stary snapshot lub prognoza poza 12 h.
- W panelu burzowym TCu/Cb rysowane są jako osobne punkty (pomarańczowy TCu, czerwony Cb) od wskaźnika 30% — tylko przy prawidłowym terminie, punkcie EPIR i pokryciu modeli. Nie są to obserwacje.
- Osobny symbol `Cu?` wskazuje interpretację opadu przelotnego bez silnego sygnału TCu/Cb; nie jest automatycznym stwierdzeniem istnienia TCu.
- Filtr ciągłości 3 h nie ukrywa godzin ze wsparciem TCu lub niezależnych modelowych opadów przelotnych.
- **Nie zmieniamy** prognozowanych sum opadu, chmur ogólnych, prawdopodobieństw zjawisk, surowych kodów WMO, burz ani generatora TAF. Szczególnie **nie podbijamy** TCu/Cb/TS tylko dlatego, że jeden model podał SHRA.

## Weryfikacja

Uruchom `node tests/meteogram-shower-cloud-consistency.test.js` oraz istniejące testy `meteogram-precipitation-evidence`, `meteogram-precipitation-continuity` i `meteogram-precipitation-types`. Walidacja GitHub Pages obejmuje nowy test.

Dla dalszej poprawy jakości prognostycznej wymagane będzie sprawdzenie klas Cu/TCu/Cb na niezależnych obserwacjach chmur, obrazach satelitarnych lub raportach lotniczych oraz strojenie na danych archiwalnych. Nie należy uczyć Cb wyłącznie z kodu SHRA.
