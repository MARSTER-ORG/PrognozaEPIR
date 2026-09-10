# PrognozaEPIR — nauka sezonowa i reżimy synoptyczne

## Cel

Warstwa `synoptic-regime` nie zastępuje bazowych wag adaptacyjnych. Koryguje je konserwatywnie wtedy, gdy historia pokazuje powtarzalną przewagę lub słabość modelu w podobnym typie pogody.

Kolejność interpretacyjna jest następująca:

`waga bazowa → horyzont → bieżąca waga adaptacyjna → kontekst sezonowo-synoptyczny → konsensus`

Bieżąca korekta obserwacyjna z METAR pozostaje osobnym mechanizmem i nie może korzystać z przyszłych obserwacji.

## Źródła i brak przecieku przyszłości

Do klasyfikacji historycznego przypadku wolno używać wyłącznie pól z archiwalnego operacyjnego przebiegu modelu, którego `run_time < valid_time`. Profile są uzupełniane z Open-Meteo **Single Runs** dla dokładnie tego przebiegu. Reanaliza nie może zastępować brakującej prognozy ani służyć do zbudowania cechy wejściowej, której model w chwili wydania prognozy nie znał.

METAR/SPECI EPIR i SYNOP są obserwacją do weryfikacji wyniku. Kierunek wiatru obserwowanego nadal ma priorytet METAR zgodnie z `metar-3-circular-v1`, a METAR `9999` pozostaje cenzurowaną dolną granicą widzialności.

## Klasyfikowane wymiary

- `season`: winter / spring / summer / autumn.
- `daypart`: night / morning / afternoon / evening według Europe/Warsaw.
- `inflow_850`: ośmiosektorowy kierunek napływu na 850 hPa; jest ważniejszym opisem masy powietrza niż sam wiatr 10 m.
- `stability_925`: inversion / stable / mixed_neutral / unstable, wyliczane z T2m, T925 i — gdy dostępne — geopotencjału 925 hPa.
- `moisture_low`: wilgotność dolnej troposfery z RH925 i RH850.
- `pressure_regime`: lokalne środowisko ciśnieniowe z MSLP. Jest to celowo nazwa „pressure environment”, a nie automatyczne stwierdzenie położenia centrum wyżu lub niżu.

Dokładny typ frontu i położenie układu barycznego wymagają pola przestrzennego. Nie są zgadywane z pojedynczego punktu.

## Uczenie wag

Porównanie jest wykonywane wyłącznie na tych samych przypadkach: ten sam `run_time`, `valid_time`, horyzont i parametr. Wynik modelu jest porównywany z medianą pozostałych dostępnych modeli. Dzięki temu model nie dostaje premii tylko dlatego, że przypadkiem był weryfikowany w łatwiejszej pogodzie.

Warstwa kontekstowa ma ograniczony zakres 0.85–1.15, minimum 24 przypadki i pełne zaufanie dopiero przy 120 efektywnych próbkach. Okres półtrwania historii wynosi 180 dni. Małe próbki automatycznie cofają korektę do 1.00.

W runtime niezależne wymiary nie są mnożone bez ograniczeń. Ich logarytmiczne modyfikatory są łączone ważoną średnią geometryczną i ponownie ograniczane do 0.85–1.15. Wagi wymiarów: sezon 0.25, pora doby 0.10, napływ 850 hPa 0.25, stabilność 925 hPa 0.20, wilgotność 0.15, środowisko ciśnieniowe 0.05.

## Wzbogacanie historii

`scripts/enrich_synoptic_context.py` uzupełnia istniejące rekordy stopniowo, żeby nie generować jednorazowo setek zapytań. Pobierane są T, RH, wiatr i geopotencjał dla 925/850/700/500 hPa. Proces jest wznawialny: rekordy już wzbogacone są pomijane, a brakujące przebiegi mogą zostać ponowione przy następnym uruchomieniu.

Jesienno-zimowe METAR-y dostarczone później można dołączyć do centralnego archiwum obserwacji. Po ich pojawieniu się uczenie automatycznie zacznie tworzyć statystyki dla jesieni i zimy; nie wolno ekstrapolować letnich korekt jako pewnych korekt zimowych.
