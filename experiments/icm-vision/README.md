# ICM Vision Probe — izolowany test PrognozaEPIR

**Status:** kod przygotowany na osobnej gałęzi, funkcja `icm-vision-probe` wdrożona osobno w Supabase z `verify_jwt=true`. Bez podłączenia do Consensus, silnika mgły i TAF. Bez automatycznego pobierania z ICM, harmonogramu i zapisu do bazy.

## Po co?
Gemini odczytuje *ręcznie dostarczony* obraz meteogramu. Wyodrębnia godzinowe wartości, opis dowodów z obrazu i oznaczenia pewności. Gdy wykres nie pokazuje jawnego UTC, pole czasu UTC pozostaje null. Niedostępna widzialność, wysokość podstaw chmur i inne brakujące parametry także pozostają null.

## Test lokalny
Node.js 20+:
- `node experiments/icm-vision/test.mjs` — kontrola poprawności walidatora (bez sieci).
- `node experiments/icm-vision/probe.mjs --image własny-meteogram.png --output wynik.json` — rzeczywiste wywołanie Gemini z kluczem `GEMINI_API_KEY` w zmiennej środowiskowej.
- `--mock experiments/icm-vision/fixture.json` — lokalny test danych syntetycznych, bez Gemini.

## Wywołanie Supabase
Funkcja `icm-vision-probe` w projekcie PrognozaEPIR, wymaga prawidłowej autoryzacji JWT. Akceptuje POST JSON:
```json
{"source":"manual","station":"EPIR","mimeType":"image/png","imageBase64":"..."}
```
Odpowiada: `ok`, `mode: manual_image_only`, `stored: false`, `result.rows`, `result.flags`. Nie pobiera URL, nie dokonuje scrapingu. Korzysta z serwerowego sekretu `GEMINI_API_KEY`, nie ujawnia go w odpowiedzi. Stosuje limit żądań na instancję, który nie jest limitem globalnym.

## Ograniczenia
Testujemy tylko obraz użyty w sposób dozwolony. ICM wymaga uzgodnienia automatycznego pobierania i dalszego publikowania danych; patrz https://faq.meteo.pl/. Funkcja nie uczy Gemini na danych. Wynik należy porównać ręcznie co najmniej dla 6 godzin. Ten eksperyment nie jest zatwierdzonym źródłem prognoz lotniczych. Status ACTIVE potwierdza wdrożenie, ale nie zastępuje testu rzeczywistego odczytu.
