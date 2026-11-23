# PrognozaEPIR — kwalifikacja mechanizmu opadów, 23.11.2026

Stan wejściowy: `main` = `992a929fd584e88827e63ea72579dee8136eaf0a`, PR #116–#119 i #121 scalone. Gałąź poprawek: `fix/precipitation-qualification-20261123`.

## Decyzja kwalifikacyjna

Poprawki programistyczne i zabezpieczenia przechodzą lokalne QA. Korekty DZ/RA pozostają sugestią fizyczno-modelową, nie skalibrowanym klasyfikatorem. **Nie wykazano poprawy sprawdzalności meteorologicznej nowego silnika. Nie aktywowano nowych wag.** Publikację można uznać za zakończoną dopiero po zielonym CI, scaleniu i potwierdzeniu commitu oraz identyczności plików na Pages. Bieżący status końcowy zostanie podany w raporcie z wdrożenia.

## Potwierdzone problemy i naprawy

1. Klient wag przypisywał DZ do `rain`, choć nauka używa `drizzle`. Poprawiono wybór klasy i dodano testy bramek aktywacji oraz neutralności shadow.
2. Brakowało mapowania 83/84 na SHRASN. Dodano je; ułamkowe wartości kodów pogodowych nie są już zaokrąglane do innego zjawiska.
3. Filtr ciągłości mógł zmienić pojedyncze SHRA/SHSN przy braku niezależnych danych konwekcji albo suchej godzinie sąsiedniej. Teraz wymaga wiarygodnych diagnostyk konwekcji w całym oknie i dodatniego RR we wszystkich trzech godzinach. Brak danych poza horyzontem konwekcji nie jest dowodem braku Cu.
4. Pamięć silnika konwekcji mogła otrzymywać nowy `updatedAt` bez nowych modeli; ponowne mieszanie mogło używać już zmieszanych danych. Zachowano czas rzeczywistego pobrania NWP, oddzielne surowe `baseRows`, kontrolę lokalizacji i wygaśnięcie po 2 h. Starsza pamięć z już zastosowanym nowcastem nie jest ponownie mieszana.
5. Diagnoza warstwowości sprawdzała tylko liczbę punktów profilu. Teraz wymaga różnych, prawidłowych poziomów obejmujących dolną i środkową troposferę, zgodności rzeczywistego profilu z reżimem oraz nieujemnej podstawy. Sygnał zjawisk niebezpiecznych w modelowych udziałach blokuje DZ/RA. Brak typu usuwa stary kontekst dymka.
6. Legenda nie objaśniała RA* z diagnozy chmur; procent zgodności kodu po korekcie mógł wyglądać jak poparcie nowej sugestii. Rozdzielono legendę filtra 3 h i profilu chmur, a dymek opisuje procent jako zgodność przed korektą. Oddzielono modelowe wskazanie rodzaju od udziału modeli z RR ≥0,1 mm/h.
7. Wczesny moduł klienta modeli/uczenia nie miał wersji buildu. Pages nadaje mu ten sam identyfikator co pozostałym modułom.
8. Stary test importu depesz oczekiwał odrzucenia historycznego ID, choć działający kontrakt normalizuje je i zachowuje `legacy_message_id`. Zaktualizowano test do istniejącego zachowania i zachowano sprawdzenie odrzucenia nieprawidłowego formatu. Nie zmieniono importu produkcyjnego.

## Fizyczne ograniczenia

Rodzaj chmury sam nie tworzy opadu. SH nie oznacza automatycznie Cb: rozwinięty Cu może dawać opad przelotny. DZ wspiera płytka, wilgotna warstwa i niezależne kody modeli, a nie samo małe RR. Profile zachmurzenia są przybliżeniem St/Sc/As/Ns, nie bezpośrednią obserwacją rodzaju chmur. Nie wyprowadzamy FZDZ/FZRA z samej temperatury 2 m. Nie zmieniamy fazy opadu, sum, danych modeli ani TAF dla wygładzenia etykiety.

Wykorzystane źródła pierwotne: [WMO — mżawka](https://cloudatlas.wmo.int/en/drizzle.html), [WMO — opad ciągły i przelotny](https://cloudatlas.wmo.int/en/hydrometeors-falling-particles.html), [NOAA/NWS — pionowy profil i opady zimowe](https://www.weather.gov/lmk/winter-precip). Nie pozyskiwano ani nie przetwarzano danych lub obrazów ICM.

## Weryfikacja historyczna

Dane obserwacyjne: 651 godzin z opadem oraz 5799 godzin uznanych za suche według zachowawczych reguł METAR/SPECI EPIR. Brak zjawiska w AUTO nie jest etykietą sucho. SYNOP 12342: 2328 dodatnich godzin analizowanych oddzielnie; nie podstawiano ich jako pogody EPIR.

Dla dodatkowego audytu rodzaju zastosowano wspólny chronologiczny podział: początek części testowej **20.10.2026 00 UTC**, embargo 24 h; 3956 przypadków w części wcześniejszej i 1155 w późniejszej. 35 przypadków bez jednoznacznego typu obserwowanego wyłączono z oceny rodzaju. Nie dostrajano progów ani wag na tej części testowej. Godziny różnych wyprzedzeń mogą opisywać ten sam epizod — liczebności nie są niezależnymi zdarzeniami.

**Poniższe wyniki dotyczą wskazań kodowych rzeczywistego modułu JS z bazowymi wagami modeli. Nie są replayem dawnego adaptacyjnego konsensusu ani skutecznością nowej korekty chmurowej.** WMO może wskazywać opad śladowy przy zerowej zaokrąglonej sumie; to audyt etykiety, nie weryfikacja progu 0,1 mm/h ani pomiaru deszczomierza.

| Wyprzedzenie | Znany typ / sucho | W tym obserwowany opad | Zgodna klasa | Błędna klasa |
|---|---:|---:|---:|---:|
| 0-3h | 220 | 19 | 66.4% | 33.6% |
| 3-6h | 278 | 29 | 65.8% | 34.2% |
| 6-12h | 160 | 22 | 63.1% | 36.9% |
| 12-24h | 146 | 17 | 64.4% | 35.6% |
| 24-48h | 152 | 14 | 56.6% | 43.4% |
| 48-120h | 164 | 17 | 42.7% | 57.3% |

Macierz pomyłek 0–3 h (wiersze: obserwacja, kolumny: prognozowana etykieta):

| Obserwacja | Bez opadu | DZ | RA | SN | VAR |
|---|---:|---:|---:|---:|---:|
| DRY | 137 | 58 | 3 | 0 | 3 |
| DZ | 0 | 7 | 2 | 1 | 0 |
| RA | 0 | 6 | 2 | 0 | 0 |
| SHRA | 0 | 0 | 1 | 0 | 0 |

Miary klas 0–3 h:

| Klasa | Obserwacje | Precision | Recall | F1 | Ocena liczebności |
|---|---:|---:|---:|---:|---|
| DZ | 10 | 0.099 | 0.700 | 0.173 | niewystarczająca |
| RA | 8 | 0.250 | 0.250 | 0.250 | niewystarczająca |
| SHRA | 1 | — | 0.000 | 0.000 | niewystarczająca |

Pełne macierze, miary modeli i horyzontów znajdują się w `precipitation-history-20261123.json`; skrypt odtworzenia: `python3 scripts/qualify_precipitation.py`. W tym holdoucie brak obserwowanych klas SN/SHSN, mieszanych i burzowych odpowiednich do oceny. Pojedyncze SHRA oraz 4–11 obserwacji DZ na przedział nie pozwalają potwierdzić przewagi modelu ani nowego silnika.

### Porównanie przed / po

**Niedostępne w wiarygodnej postaci.** Historyczne archiwum modeli nie zapisuje kompletnego pakietu wejść przeglądarkowego silnika: profili ciśnieniowych chmur wraz z podziałem rain/showers/snowfall, równoczesnym stanem POLRAD i konwekcji oraz oryginalną i skorygowaną decyzją. Osobne archiwum profili chmur nie jest historycznym zapisem decyzji opadowej. Nie zastępowano braków dzisiejszym radarem, aktualnymi wagami ani wymyślonym profilem. Retrospektywna analiza kodów nie zastępuje przyszłego, nietkniętego zbioru walidacyjnego.

## Nauka i wagi

Uruchomiono istniejący `build_precipitation_learning.py` lokalnie. Zachowuje chronologiczne podziały z embargo, ranking uwzględniający fałszywe alarmy i osobne klasy/wyprzedzenia. Wszystkie 6 przedziałów nie spełnia bramek holdoutu; żadna klasa nie kwalifikuje się do aktywacji. `mode=shadow_only`, wszystkie `active=false`. Do statystyk dodano jawne Precision, Recall i F1. Brak zweryfikowanej godzinowej serii deszczomierza blokuje uczenie sum mm/h. Podziały poszczególnych modeli uczących mogą mieć inne daty od wspólnego podziału audytu powyżej.

## QA i publikacja

- 56 lokalnych zestawów JS/Python: PASS, w tym typy, profil, konwekcja/radar, ciągłość, niebezpieczne zjawiska, braki danych, wagi, regresje meteogramu i TAF.
- Bazowe 32 zestawy opadowe/meteogramu/TAF przechodziły również przed poprawkami; dodano regresje konkretnych luk, zamiast traktować bazowy PASS jako pełną kwalifikację.
- Zbudowano kanoniczny artefakt `prepare_pages_v241.py` i `wire_fog_mifg_utc_runtime.py`. Weryfikator sprawdza 32 lokalne zasoby indeksu, kolejność i pojedyncze ładowanie modułów oraz zgodność ich bajtów ze źródłami.
- Produkcja przed poprawkami: wykres, szczegóły opadu i przełączenie 120 h działają; brak błędów aplikacji w konsoli. Osobny błąd rozszerzenia przeglądarki nie pochodził z kodu strony.
- Lokalne Chromium nie uruchomiło się z powodu ograniczeń środowiska (`socket(): Operation not permitted`). Nie zaliczono tego jako PASS. Dodano deterministyczny test prawdziwego artefaktu w CI: widok 1440×1000 i 390×844, horyzonty 48/72/120 h, kliknięcia/tapnięcia, dymki, błędy JS, braki profilu, ochrona FZRA i czas obliczeń. Dane w tym teście są fixture, a nie wyniki sprawdzalności pogody.
- Workflow Pages sprawdzi również po wdrożeniu dokładny commit, HTTP i identyczność modułów opadowych ze źródłami.

Warunki dalszej pełnej kwalifikacji meteorologicznej: zapis pełnych pakietów wejść i obu decyzji przed terminem obserwacji, więcej lokalnych przypadków DZ/SHRA/SN/SHSN/mieszanych/burz, pionowe profile T/Tw dla niezależnej diagnozy marznięcia i oddzielny prospektywny holdout.
