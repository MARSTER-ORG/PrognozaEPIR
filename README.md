# PrognozaEPIR

Multimodelowy meteogram lotniczy dla lotniska EPIR Inowrocław.

**Kanoniczny punkt odniesienia projektu (ARP EPIR): `52.828611, 18.330278`.** Bieżące zapytania modelowe, obliczenia odległości i moduły lokalne powinny używać tego punktu. Współrzędne stacji sąsiednich oraz historyczne dane źródłowe zachowują własne, rzeczywiste lokalizacje.

## Centralne archiwum depesz

Strona jest publikowana jako statyczny HTML przez GitHub Pages. Automatyczne pozyskiwanie depesz METAR/SPECI/TAF/SYNOP wykonuje zewnętrzny `central-ingestor` na Railway. Pełny cykl pozyskania działa co 5 minut, a lekki probe oficjalnego IMGW Aviation API dla METAR/SPECI działa częściej.

Docelowa ścieżka danych jest jedna:

`dostawcy meteorologiczni -> Railway central-ingestor -> Supabase PostgreSQL -> message-archive Edge Function -> message-archive-client.js -> moduły PrognozaEPIR`

**Supabase jest głównym źródłem odczytu centralnego MessageArchive.** Wspólny `message-archive-client.js` pobiera z niego `latest`, `recent`, zakresy czasowe i dzienne strumienie archiwalne. Railway oraz statyczne `data/messages` na GitHub Pages pozostają warstwami zapasowymi/mirrorem, a nie podstawowym źródłem dla frontendu.

Podstrony i silniki, w tym generator TAF, ARCH, weryfikacja TAF oraz moduły wymagające bieżącej obserwacji, nie powinny pobierać depesz bezpośrednio od dostawców meteorologicznych. Korzystają z `PrognozaEPIRMessageArchive` udostępnianego przez `message-archive-client.js`.

Supabase przechowuje pełną historię METAR/SPECI/TAF/SYNOP i bieżące snapshoty TAF stacji sąsiednich. Deduplikacja jest wykonywana po stronie archiwum. Railway zapisuje nowe rekordy do Supabase niezależnym mirrorem; chwilowa awaria Supabase nie zatrzymuje pozyskiwania depesz ani zapasowego archiwum JSON.

Wszystkie czasy prezentowane użytkownikowi w PrognozaEPIR mają być podawane wyłącznie w UTC i oznaczone `UTC`.