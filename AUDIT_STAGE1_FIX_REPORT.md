# PrognozaEPIR Stage 1 Fix Report

## 1. Branch

`fix/audit-stage1-core-contracts`

Branch review nie został scalony z `main` ani wdrożony na produkcję.

## 2. Commit bazowy

`97883826ce3cea2244a248752e37aa61cbba5bb7` (`origin/main` po review rebase).

## 3. Lista wykonanych commitów

1. `5a9b7eaa` `fix(supabase): version message archive ingest contract`
2. `5f504a22` `fix(taf): validate active v25 v243 runtime`
3. `57414632` `fix(taf): make fog vnext policy explicit`
4. `9d9101e8` `fix(fog): route observations through message archive`
5. `72e5e61f` `docs: add stage 1 fix report`
6. `review follow-up commit: HEAD` `fix(supabase): tighten archive contract before staging`

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
- `scripts/repository_storage_guard.py`
- `scripts/sync_supabase_messages_to_git.py`
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
- `tests/test_repository_storage_guard.py`
- `tests/test_supabase_message_contract.py`
- `tests/test_sync_supabase_messages_to_git.py`
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
- Finalny `_site`: 7 stron HTML, 70 plików JS, 65 sprawdzonych lokalnych referencji, wszystkie wygenerowane pliki JS poprawne składniowo.
- I-01 dodatkowo: Deno type-check Edge Function PASS, parser SQL przyjął 29 statements, test mirror -> ingest -> archive PASS.

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

## Stage 1 review follow-up

### Rebase

- Branch zrebase'owano na `97883826ce3cea2244a248752e37aa61cbba5bb7`, aktualny `origin/main` przed pełnym przebiegiem testów.
- Dziesięć nowych commitów `main` dotyczyło wyłącznie `data/messages` oraz `data/learning`. Pozostają one w bazie brancha i nie są częścią diffu Stage 1.

### RLS i granty

- Migracja odbiera `public`, `anon` i `authenticated` bezpośrednie uprawnienia do tabel `messages` i `stations` oraz usuwa publiczne polityki SELECT oparte na `using (true)`.
- `service_role` zachowuje wymagany odczyt tabel oraz zapis do `messages`. Publiczne API `message-archive` nie zmieniło kontraktu i nadal wykonuje zapytania po stronie Edge Function z `service_role`.
- `sync_supabase_messages_to_git.py` i `repository_storage_guard.py` zostały przełączone z anonimowego PostgREST na istniejące API `message-archive`; frontend nadal używa anon key wyłącznie do wywołania Edge Function.

### WMO 12342

- Lotniska `EPIR`, `EPBY`, `EPKS` i `EPPW` są seedowane jako ICAO. Stacja `12342` jest seedowana jako `wmo='12342'`, `icao=NULL`.
- Wąska korekta istniejącego błędnego seeda dotyczy wyłącznie wiersza `icao='12342' AND wmo IS NULL` i wykonuje się tylko wtedy, gdy nie istnieje już wiersz `wmo='12342'`. Seed nie tworzy duplikatu, jeśli istnieje którykolwiek z tych wariantów.
- RPC mapuje pięciocyfrowe numery stacji wyłącznie przez WMO, a pozostałe kody przez ICAO.

### Kontrole

- JS: 15/16 PASS; jedyny FAIL to znany I-14 w `fog-physics-vnext.test.js`.
- Python: 17/17 PASS; `py_compile` 123/123 PASS.
- Archive boundaries, kontrakt Supabase, finalizer TAF, archiwum obserwacji FOG, UTC i Cloudflare 4/4: PASS.
- Pages: build i wiring PASS, składnia JS 70/70 PASS, lokalne assety oraz kolejność MessageArchive przed aktywnymi runtime'ami TAF/FOG: PASS.

### Bezpieczeństwo migracji przed stagingiem

- `CREATE TABLE IF NOT EXISTS` jest bezpieczne dla brakujących tabel, ale dla tabel już istniejących nie dodaje ani nie naprawia brakujących kolumn, constraints lub defaults.
- `CREATE INDEX IF NOT EXISTS` zakłada zgodne istniejące kolumny: `stations.icao`, `stations.wmo` oraz `messages.content_hash`, `message_type`, `station_code`, `archive_time`, `id`, `station_id` i `source_id`.
- Klucze obce i funkcja ingest zakładają UUID w `stations.id`/`message_sources.id`, zgodne typy wszystkich używanych kolumn `messages` oraz automatyczne generowanie `messages.id`; obsługa sekwencji działa tylko wtedy, gdy `pg_get_serial_sequence` ją odnajdzie.
- Migracja została sprawdzona statycznie, parserem SQL i testami kontraktowymi. Przed merge/deploy musi zostać zastosowana na klonie stagingowym aktualnego schematu i danych, aby potwierdzić powyższe założenia oraz działanie Edge Functions.
- Nie uruchomiono migracji Supabase, nie wdrożono Edge Function i nie wykonano żadnego deploymentu.
