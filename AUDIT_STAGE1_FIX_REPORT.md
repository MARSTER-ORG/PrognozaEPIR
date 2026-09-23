# PrognozaEPIR Stage 1 Fix Report

## 1. Branch

`fix/audit-stage1-core-contracts`

Branch jest lokalny i nie został scalony z `main` ani wdrożony na produkcję.

## 2. Commit bazowy

`04e987bcdc0c7459f075e4d3174d57e22f3a1054` (`origin/main` w chwili utworzenia brancha).

## 3. Lista wykonanych commitów

1. `25500d75` `fix(supabase): version message archive ingest contract`
2. `e88d5f1d` `fix(taf): validate active v25 v243 runtime`
3. `9e8c722d` `fix(taf): make fog vnext policy explicit`
4. `0e5b860d` `fix(fog): route observations through message archive`
5. `report commit: HEAD` `docs: add stage 1 fix report`

## 4. I-01 - Supabase ingest / schema contract

- Dodano wersjonowaną migrację bazowego kontraktu `message_sources`, `stations` i `messages`, wraz z typami, constraints, indeksami, grantami, RLS oraz atomowym RPC `ingest_message_batch(jsonb)`.
- Dodano Edge Function `message-ingest`, zgodną z payloadem `scripts/supabase_message_mirror.py`: walidacja JSON, limit 1-500 rekordów i 8 MiB, walidacja identyfikatorów/czasów/typów/stacji, deduplikacja po `content_hash` i kontrolowane mapowanie pól.
- Upsert aktualizuje wyłącznie metadane duplikatu i wzbogacenie rekordu o zgodnej tożsamości; konflikt tożsamości nie może nadpisać niepowiązanego rekordu.
- Service role pozostaje po stronie serwera. Ingest jest chroniony stałoczasowym porównaniem `x-ingest-token`; odpowiedzi klienta nie ujawniają sekretów ani szczegółów serwera.
- Kontrakt został porównany z dostępnym publicznie, tylko do odczytu kształtem produkcyjnego API. Nie wykonano zapisu ani zmiany w Supabase production.

## 5. I-03 - TAF finalizer

- Finalizer analizuje aktywne znaczniki `<script>` i rzeczywistą sekwencję dynamicznego `loadScript`, pomijając komentarze HTML/JS.
- Wymaga aktywnego `taf-app-v25.js`, silnika `taf-engine-v243.js`, warstwy `taf-fog-policy.js`, poprawnej kolejności zależności i zgodności wersji UI/runtime `2.4.3`.
- Odrzuca aktywne `taf-app-v2.js`, fałszywe markery istniejące wyłącznie w komentarzu i niezgodne wersje aplikacji.
- `prepare_pages_v241.py` używa tego samego walidatora wobec finalnego `_site`.

## 6. I-05 - Polityka FOG w TAF

- Generator TAF ma jeden kontrakt: `TAF -> Fog vNext`.
- Usunięto z `taf.html` przełącznik Legacy/vNext, zapis/odczyt trybu z `localStorage` i eventy zmiany trybu dotyczące TAF.
- UI pokazuje `Fog source: vNext`; aplikacja używa `TAF_FOG_MODE='vnext'` oraz `seriesForTaf()`.
- Wartość `legacy` zapisana przez inne części projektu nie zmienia źródła TAF i nie powoduje fallbacku do Legacy.
- Legacy pozostaje dostępne w pozostałych częściach projektu.

## 7. I-17 - FOG 2.4.4 MessageArchive

- `fog.html` ładuje `message-archive-client.js` przed FOG 2.4.4.
- `fog-engine-v244.js` pobiera obserwacje najpierw przez `PrognozaEPIRMessageArchive.latest(true)`, korzystając tym samym z Supabase i fallbacków należących do wspólnego klienta.
- Bezpośredni `data/messages/latest.json` pozostaje wyłącznie końcowym fallbackiem po braku klienta lub całkowitym niepowodzeniu klienta.
- Checker granic archiwum rozpoznaje dozwolony końcowy fallback, wykrywa inne bezpośrednie odczyty i akceptuje aktualny bridge-only `mifg-engine.js`.
- Walidator `wire_fog_mifg_utc_runtime.py` wymaga klienta przed FOG 2.4.4 w finalnym Pages buildzie.

## 8. Pliki zmienione

Kod i konfiguracja:

- `.github/workflows/pages-v2.yml`
- `fog-engine-v244.js`, `fog.html`
- `scripts/check_archive_boundaries.py`
- `scripts/finalize_central_message_architecture_v2.py`
- `scripts/prepare_pages_v241.py`
- `scripts/wire_fog_mifg_utc_runtime.py`
- `supabase/config.toml`
- `supabase/functions/message-ingest/contract.mjs`
- `supabase/functions/message-ingest/index.ts`
- `supabase/migrations/20260923171744_create_message_archive_contract.sql`
- `taf-app-v25.js`, `taf-fog-policy.js`, `taf.html`

Testy:

- `tests/fog-native-page-contract.test.js`
- `tests/fog-observation-archive.test.js`
- `tests/message-ingest-contract.test.js`
- `tests/runtime-integration-contract.test.js`
- `tests/taf-engine-v2.test.js`
- `tests/taf-fog-policy.test.js`
- `tests/test_archive_boundaries.py`
- `tests/test_supabase_message_contract.py`
- `tests/test_taf_finalizer_runtime.py`

Nie zmieniono danych historycznych, JSONL, cache ani śledzonych artefaktów `_site`.

## 9. Testy PASS

- `node --check`: 90/90 źródłowych plików JS poza `data` i `_site`.
- `tests/*.js`: 15/16 testów PASS; wszystkie testy dodane lub zmienione w tym etapie są zielone.
- `python -m py_compile`: 123/123 plików Python.
- `tests/test_*.py`: 17/17 testów PASS.
- `python scripts/check_archive_boundaries.py`: PASS.
- `python scripts/enforce_global_utc.py --check`: PASS na źródłach, przy nieobecnym `_site`.
- Cloudflare: oba `node --check` PASS, `core.test.mjs` 4/4 PASS.
- `python scripts/prepare_pages_v241.py`: PASS.
- `python scripts/wire_fog_mifg_utc_runtime.py`: PASS.
- Finalny `_site`: 7 stron HTML, 70 plików JS, komplet lokalnych assetów, wszystkie wygenerowane pliki JS poprawne składniowo.
- I-01 dodatkowo: Deno type-check Edge Function PASS, parser SQL przyjął 31 statements, test mirror -> ingest -> archive PASS.

## 10. Testy FAIL

- `tests/fog-physics-vnext.test.js`: 1 znany FAIL spoza zakresu. Test oczekuje markera `validated-production-2026-09-15`, a runtime zwraca `physics-state-gated-authoritative-render-2026-09-16`. Odpowiada to I-14, którego ten branch zgodnie z poleceniem nie naprawia.

Nie stwierdzono nowej porażki związanej z I-01, I-03, I-05 ani I-17.

## 11. Znane ograniczenia

- Nie wykonano integracji z lokalną bazą Supabase, ponieważ lokalny Docker daemon nie był dostępny. Migracja została sprawdzona statycznie i parserem SQL, a przepływ pokryto testami kontraktowymi.
- `enforce_global_utc.py --check` uruchomiono bez `_site`, ponieważ znany I-19 powoduje fałszywe zgłoszenia dla artefaktu builda. Finalny `_site` sprawdzono osobno.
- Test zależny od polecenia `node` uruchomiono z dołączonym do środowiska bundled Node; portability I-15 nie była zmieniana.
- Nie wykonano deployu ani testu na środowisku staging/production.

## 12. Czy zachowanie produkcji zmieniło się

Nie, ponieważ branch nie został wdrożony. Po przyszłym wdrożeniu zmieni się zachowanie aplikacji: TAF będzie jawnie i wyłącznie używał Fog vNext, a FOG 2.4.4 będzie pobierał obserwacje przez wspólny MessageArchive jako primary. Walidatory CI/Pages będą egzekwować te kontrakty.

## 13. Czy migracja Supabase wymaga ręcznego deployu

Tak. Plik `supabase/migrations/20260923171744_create_message_archive_contract.sql` jest wyłącznie wersjonowany w repozytorium. Wymaga kontrolowanego zastosowania na właściwym projekcie Supabase po przeglądzie i teście stagingowym. Migracji nie uruchomiono na produkcji.

## 14. Czy message-ingest wymaga deployu Edge Function

Tak. `supabase/functions/message-ingest` wymaga osobnego, kontrolowanego deployu Edge Function oraz skonfigurowania sekretu `MESSAGE_INGEST_TOKEN`. Funkcji nie wdrożono na produkcję.

## 15. Ryzyka przed merge

- Przed merge/deploy należy wykonać migrację i test Edge Function na stagingu z kopią reprezentatywnych METAR/SPECI/TAF/SYNOP.
- Należy potwierdzić konfigurację sekretu ingest oraz świadomą decyzję `verify_jwt=false`, która jest kompensowana własnym tokenem serwisowym.
- Istniejący FAIL I-14 powinien zostać zaakceptowany jako znany albo rozwiązany w osobnym branchu przed wymaganiem całkowicie zielonego CI.
- Należy zachować kolejność wdrożenia: migracja bazy, Edge Function ingest, następnie frontend/Pages.

## 16. Rekomendowany kolejny etap

1. Uruchomić staging Supabase i wykonać integracyjny test ingest -> tables -> message-archive bez dotykania produkcji.
2. Naprawić osobno I-14, I-15 i I-19, aby pełny zestaw testów był zielony bez wyjątków środowiskowych.
3. Po review brancha przygotować oddzielny, kontrolowany plan deployu z rollbackiem dla migracji i Edge Function.

Porównanie po opublikowaniu brancha: https://github.com/MARSTER-ORG/PrognozaEPIR/compare/main...fix/audit-stage1-core-contracts
