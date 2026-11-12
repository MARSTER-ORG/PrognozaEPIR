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

## Tryb automatycznego pobierania (wersja 2, zablokowany bez autoryzacji)
Przed uzyskaniem pisemnej zgody ICM nie wolno automatycznie pobierać obrazów z ich strony. Dokumentacja: https://www.meteo.pl/regulamin-aplikacji-meteo-icm . Nie ma scrapingu ani wywołań do strony app.meteo.pl.

Funkcja `icm-vision-probe` wspiera `{"source":"auto","station":"EPIR"}` i sama pobiera binarny obraz z **autoryzowanego** endpointu ICM API, a następnie przekazuje go do Gemini i normalizuje parametry.

Niezbędne sekrety serwera Supabase po uzgodnieniu dostępu:
- `ICM_IMAGE_AUTO_APPROVED=true` — ustawiane dopiero po zatwierdzeniu warunków.
- `ICM_AUTHORIZED_IMAGE_URL` — pełny, autoryzowany URL obrazu HTTPS pod domeną `api.meteo.pl`.
- `ICM_API_TOKEN` — token dostępu otrzymany od operatora; autoryzacja Bearer (do dostosowania do rzeczywistego API).
- `GEMINI_API_KEY` — istniejący klucz, przechowywany w Supabase.

Jeżeli ICM udostępni obrazy poprzez inny autoryzowany host, należy zmienić listę dozwolonych domen po weryfikacji dokumentacji i zgody. Funkcja **nie** podąża za przekierowaniami i odrzuca HTML. Zwraca jawny błąd, gdy źródło nie jest skonfigurowane. Nie zbiera danych przez publiczne endpointy lub emulator przeglądarki.

Przyszła cykliczność: po uzgodnieniu źródła i parametrów dostępności można dodać wyzwalanie zgodne z cyklami UM (oraz deduplikację w bazie testowej), nadal bez wpływu na Consensus. Obecnie nie jest uruchomiony harmonogram. Test adaptera bez sieci: `node tests/icm-authorized-source.test.mjs`.
