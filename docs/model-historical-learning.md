# PrognozaEPIR — nauka historyczna i weryfikacja modeli

## Cel

Mechanizm historyczny ocenia modele używane w PrognozaEPIR na podstawie prognoz, które rzeczywiście istniały przed terminem ich ważności. Reanaliza nie może zastępować brakującego runu operacyjnego. Wyniki służą do doboru wag modelowych, diagnostyki błędów oraz kontroli, czy bieżące wagi adaptacyjne są zgodne z dłuższą historią.

## Źródła

- prognozy: archiwum `data/learning/model-forecasts/`, w tym historyczne runy Open-Meteo Single Runs,
- obserwacje lotniskowe: EPIR METAR i SPECI,
- obserwacje uzupełniające: SYNOP WMO 12342,
- bieżące wagi: `data/learning/adaptive-weights.json`,
- pełny audyt historyczny: `data/learning/historical-model-skill.json`.

## Zasady obserwacji

Kierunek wiatru ma priorytet METAR nad SYNOP. Regularne METAR-y są nominalnie co 30 minut. Przy słabym wietrze lub szybkich zmianach kierunku referencja jest liczona z trzech regularnych METAR-ów wokół terminu weryfikacji metodą średniej kołowej/wektorowej. Przykład 350°, 010°, 020° daje około 007°, a nie średnią arytmetyczną 127°.

Widzialność METAR `9999` jest traktowana jako obserwacja cenzurowana z dołu: co najmniej około 10 km, a nie dokładnie 10 000 m. Takie przypadki nie wchodzą do MAE/RMSE widzialności jako dokładna wartość. Mogą natomiast potwierdzać brak zdarzenia dla progów widzialności, jeśli dolna granica jest powyżej danego progu.

## Metryki

Dla temperatury, punktu rosy, ciśnienia, prędkości wiatru i dokładnych obserwacji widzialności raportuje się bias, MAE, RMSE i 90. percentyl błędu bezwzględnego. Kierunek wiatru używa błędu kołowego, kołowego biasu, MAE kierunku i P90 błędu kątowego.

Dla zdarzeń progowych raportowane są trafienia, pominięcia, fałszywe alarmy i poprawne odrzucenia oraz POD, FAR, CSI, frequency bias i accuracy. Obecnie obejmuje to widzialność poniżej 10 km, 5 km i 1,5 km oraz opad.

## Porównanie modeli

Nie porównuje się prostych średnich z różnych zestawów przypadków. Dla każdego wspólnego `run_time`, `valid_time`, horyzontu i parametru wynik modelu jest porównywany z medianą innych dostępnych modeli dla dokładnie tego samego przypadku. Dzięki temu brak historycznych runów jednego modelu nie daje przewagi ani kary tylko dlatego, że model trafił na łatwiejszą lub trudniejszą pogodę.

Historyczny współczynnik jest bez wygaszania czasu i służy jako długookresowa diagnoza. Wartość powyżej 1 oznacza przewagę nad medianą modeli w tych samych przypadkach, poniżej 1 — słabszy wynik. Współczynnik jest ograniczony do 0,72–1,28 i przy małej liczbie próbek jest ściągany do 1,0.

## Wagi produkcyjne

Produkcja używa `adaptive-weights.json`. Wagi są liczone osobno dla parametrów i horyzontów 0–3 h, 3–6 h, 6–12 h, 12–24 h, 24–48 h i 48–120 h. Korzystają z całego dostępnego archiwum, ale starsze przypadki mają mniejszy wpływ (half-life 45 dni). Ogranicza to ryzyko, że zachowanie modelu sprzed kilku miesięcy zdominuje aktualny profil błędów.

Pełny audyt historyczny nie zastępuje wag produkcyjnych. Jest niezależnym sprawdzeniem ich sensowności i pozwala wykrywać stabilne biasy, problemy zależne od parametru, horyzontu lub miesiąca oraz pogorszenie jakości modelu.

## Ograniczenia interpretacji

Obecny backfill zaczyna się 1 czerwca 2026 i nie obejmuje jeszcze pełnego cyklu sezonowego. Braki runów są jawnie raportowane w `model-backfill-state.json`. Dopóki archiwum nie obejmie jesieni i zimy, współczynniki nie powinny być agresywnie ekstrapolowane na warunki chłodnej pory roku. Szczególnie widzialność, mgła, niskie podstawy chmur i wiatr przy warstwie przyziemnej wymagają kontroli sezonowej.

Ogólny procent sprawdzalności jest wskaźnikiem pomocniczym. Do decyzji operacyjnych ważniejsze są wyniki komponentowe, błędy surowe i metryki zdarzeń rzadkich, zwłaszcza spadków widzialności i istotnych zmian wiatru.
