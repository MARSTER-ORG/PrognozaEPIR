# Meteogram EPIR — ciągłość czasowa rodzaju opadu

## Stan po zmianie (2026-11-22)

Nowy moduł `meteogram-precipitation-continuity.js` działa **po** klasyfikacji fazy i charakteru oraz **po** ocenie sygnałów POLRAD/NWP (`meteogram-precipitation-evidence.js`). Nie zmienia surowych prognoz modeli, sum godzinowych `RR`, prawdopodobieństwa opadu, burzy ani danych dla generatora TAF. Dotyczy wyłącznie wizualnej klasyfikacji na meteogramie CONSENSUS. Widok pojedynczego modelu pozostaje bez korekty.

Filtr jest ostrożną, wyjaśnialną regułą **3 kolejnych godzin**. Potrafi ustabilizować pojedyncze, słabiej potwierdzone przejście `RA → SHRA → RA` do `RA → RA* → RA`, analogicznie `SN → SHSN → SN`. Gwiazdka informuje, że jest to korekta prezentacji, nie nowy kod WMO wyznaczony bezpośrednio z danych.

## Warunki dopuszczenia korekty

- Wszystkie trzy chwile leżą w sąsiednich terminach godzinowych (tolerancja ±7,2 min); nie wolno przechodzić przez luki w danych i granice widocznego zakresu.
- Ta sama rodzina hydrometeorów we wszystkich trzech godzinach: wyłącznie deszcz albo śnieg, bez ingerencji w opad mieszany, marznący, z gradem, z burzą lub nierozstrzygnięty VAR.
- Co najmniej trzy modele wykazują opad w każdej godzinie. Zgodność fazy w środkowej godzinie ≥70%, w sąsiednich ≥75%; udział opadu odpowiednio ≥60/65%.
- W środkowej godzinie charakter przelotny ma jedynie umiarkowane poparcie (65–79%). W sąsiednich godzinach ≥70% wag opadowych wspiera charakter nieprzelotny.
- Brak wskazań konwekcji z NWP, prognozowanego echa radarowego i znacznika potwierdzającego w dowolnej z trzech godzin.
- Temperatura we wszystkich trzech godzinach jest znana i oddalona o ponad 1,5°C od zera, prawdopodobieństwo burzy niższe niż 35%, a środkowa suma opadu nie jest gwałtownym lokalnym maksimum.
- Istnieją wszystkie trzy wartości `RR`, a środkowa nie wynosi 0 (zero nie może zostać wygładzone do opadu).

Nadal rozróżniamy rzeczywiste opady przelotne. Izolowany `SHRA` z silnym poparciem modeli, radaru, konwekcji lub wyraźnym wzrostem intensywności pozostaje `SHRA`. `RA/SN/RA` nie jest korygowane do deszczu, a `RA/SN` z różnych modeli nie zamienia się automatycznie w `RASN`. Nie uzupełniamy brakujących godzin ani chwil bezopadowych.

## Widok

- Kolor oraz kod `RA*` / `SN*` na meteogramie odpowiadają **skorygowanej prezentacji**.
- Dymek i szczegóły zjawiska pokazują pierwotny kod (`SHRA` lub `SHSN`), przyczynę korekty i informację, że wartości liczbowe nie zostały zmienione.
- Powtórny rendering jest odwracalny: pojawienie się nowego potwierdzenia radaru/konwekcji lub zmiana wyboru modelu przywraca surową klasyfikację.

## Zakres i kolejne kroki

Filtr jest deterministyczny, nie jest dodatkową nauką opadów. Historyczne współczynniki wag z `data/learning/precipitation-learning.json` pozostają kontrolowane przez niezależny holdout i tryb shadow. W przyszłości można stroić progi filtra na archiwum godzinowych danych modelowych i obserwacyjnych, ale tylko na danych nieużytych przy ocenie.

Testy: `node tests/meteogram-precipitation-continuity.test.js` oraz istniejące testy typów, POLRAD i budowania Pages.
