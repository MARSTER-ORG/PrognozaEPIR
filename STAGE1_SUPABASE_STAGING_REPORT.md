# Stage 1 Supabase staging / pre-merge report

Data walidacji: 2026-09-23 (UTC)

Zakres: branch `fix/audit-stage1-core-contracts`, bez merge, bez deploymentu,
bez zapisu do produkcji i bez uruchamiania migracji na projekcie linked.

## 1. Git HEAD

- Zweryfikowany commit z poprawkami stagingowymi:
  `4b8ea1524a5e8b325acf3098cf26d5a926953b31`.
- Commit zawierający ten raport: `HEAD`.
- Branch został zrebase'owany na aktualny `origin/main`; nowe commity `main`
  dotyczyły wyłącznie automatycznych danych `data/messages`, `data/learning`
  i `data/runtime`.

## 2. origin/main

- `origin/main`: `7c8712e1cbae5d6939486f6910f58d190aacb07e`.
- Po rebase: `origin/main...HEAD = 0 behind / 6 ahead` przed dodaniem dwóch
  commitów walidacyjnych.
- Nie stwierdzono konfliktu semantycznego z plikami Etapu 1.

## 3. Clean-room local result

`CLEAN LOCAL DATABASE: PASS`

- Supabase CLI 2.117.0 i lokalny Docker działały poprawnie.
- Wykonano `supabase db reset --local` na niezlinkowanym środowisku lokalnym.
- Baza została odtworzona wyłącznie z wersjonowanych migracji repozytorium.
- Nie użyto `db push`, `db reset --linked`, `migration repair` ani produkcyjnych
  sekretów.

## 4. Migration execution result

PostgreSQL rzeczywiście wykonał, w kolejności:

1. `20260920124012_add_safe_message_archive_retention.sql`
2. `20260923171744_create_message_archive_contract.sql`

Reset zakończył się komunikatem `Finished supabase db reset`. Istnieją i są
wywoływalne:

- `public.ingest_message_batch(jsonb)` jako `SECURITY INVOKER`,
- `public.run_message_archive_retention()` jako ograniczony `SECURITY DEFINER`.

Sprawdzono rzeczywiste tabele, constraints, indeksy, funkcje i ACL w katalogach
PostgreSQL. Samo parsowanie SQL nie było traktowane jako test migracji.

## 5. Actual schema before migration

Wykonano wyłącznie odczytową inspekcję projektu Supabase
`qozgntzeormujmqzkkmd` (`PrognozaEPIR`, PostgreSQL 17.6.1). Nie wykonano DDL
ani DML.

Stan zastany:

- `message_sources`: 11 wierszy, wymagane kolumny obecne.
- `stations`: 5 wierszy; `icao` było `NOT NULL`, `name` nullable, brak unikalnego
  indeksu WMO. `12342` miało `icao='12342'`, `wmo=NULL`.
- `messages`: 35 215 wierszy i wszystkie wymagane kolumny. `content_hash` oraz
  `archive_time` są kolumnami generated; `duplicate_count` ma typ integer,
  kierunek wiatru smallint, a prędkości/temperatura/QNH numeric.
- Istniejący klucz deduplikacji to
  `(message_type, station_code, archive_time, content_hash)`.
- Wykryto 56 grup powtórzonego `content_hash`, łącznie 74 dodatkowe wiersze.
  Wszystkie dotyczyły tej samej stacji, typu i treści w różnych czasach;
  nie było konfliktów cross-identity.
- Jeden historyczny wiersz ma kierunek wiatru poza zakresem 0..360.
- `ingest_message_batch(jsonb)` nie istniało.
- Historia migracji kończyła się na `20260920124012`; migracja kontraktu nie
  była zastosowana.
- Produkcja nadal ma przed migracją szerokie grants dla `anon` i
  `authenticated` oraz polityki SELECT, w tym `public read messages USING true`.

## 6. Actual schema after migration

Migrację kontraktu wykonano na lokalnej bazie odtwarzającej opisany wyżej
kształt istniejącego schematu i reprezentatywne przypadki danych.

Wynik:

- migracja przeszła bez utraty wierszy,
- dwa historyczne wiersze o tym samym hashu i różnych czasach pozostały,
- `12342` zostało zmienione na `icao=NULL`, `wmo='12342'`,
- time-aware unique key pozostał zgodny z produkcją,
- RPC ingest zostało utworzone,
- constraints zostały dodane i zwalidowane poza
  `messages_wind_direction_chk`, które celowo pozostaje `NOT VALID` z powodu
  jednego zastanego sentinela; ograniczenie obowiązuje dla nowych zapisów,
- nie wykonano automatycznej transformacji tego historycznego sentinela.

RPC na tej kopii zwróciło kolejno: insert 1, duplicate 1 bez drugiego wiersza,
oraz SQLSTATE `23505` dla konfliktu hash/tożsamość.

## 7. RLS / grants

`RLS SECURITY: PASS` dla stanu po migracji.

- RLS jest włączone na `messages`, `stations`, `message_sources`,
  `message_retention_alt_stations` i `message_retention_log`.
- Rzeczywiste zapytania jako `anon` i `authenticated` do `messages` i
  `stations` kończą się `permission denied`.
- `service_role` może SELECT z `messages`/`stations`, INSERT/UPDATE `messages`
  i EXECUTE `ingest_message_batch`.
- Po migracji nie ma grants do trzech tabel archiwum dla `anon` ani
  `authenticated` oraz nie ma polityk public read.
- Sprawdzono `pg_class`, `information_schema.role_table_grants`, `pg_policies`
  i `pg_proc`; brak przypadkowej polityki `USING (true)` w stanie docelowym.

Uwaga: powyższy PASS dotyczy zweryfikowanego stanu migracji. Projekt
produkcyjny pozostaje w stanie przed migracją i nie został zmieniony.

## 8. WMO 12342

`WMO 12342: PASS`

- Clean-room seed: EPIR, EPBY, EPKS i EPPW jako ICAO; `12342` jako
  `icao=NULL`, `wmo='12342'`.
- A, brak 12342: tworzony jest jeden canonical WMO.
- B, istniejące `wmo='12342'`: istniejący wiersz pozostaje.
- C, legacy `icao='12342', wmo=NULL`: wiersz jest naprawiany po bezpiecznym
  usunięciu legacy `NOT NULL` z `stations.icao`.
- D, canonical WMO i legacy ICAO jednocześnie: migracja zachowuje oba wiersze
  i nie usuwa danych bez jawnej reguły rozstrzygającej.
- SYNOP 12342 po ingest został połączony z wierszem WMO, nie z ICAO.

## 9. message-ingest tests

`MESSAGE INGEST E2E: PASS`

Na prawdziwej lokalnej Edge Function i bazie sprawdzono odpowiedź HTTP oraz
liczbę/treść wierszy po każdym przypadku:

1. brak tokena -> 401, DB bez zmian,
2. błędny token -> 401,
3. zły Content-Type -> 415,
4. niepoprawny JSON -> 400,
5. pusty batch -> 400,
6. batch 501 -> 400,
7. METAR EPIR -> insert,
8. ten sam METAR -> duplicate, jeden wiersz i `duplicate_count=1`,
9. SPECI EPIR -> insert,
10. SYNOP 12342 -> insert i join po WMO,
11. TAF EPIR -> insert,
12. TAF EPBY -> insert snapshotu sąsiada,
13. błędny `message_id` -> 409, DB bez zmian,
14. konflikt hash/tożsamość -> 409, DB bez zmian,
15. `valid_to < valid_from` -> 400, DB bez zmian.

Końcowa liczba poprawnych wierszy wyniosła 5.

CLI Supabase odrzuca niestandardowe nazwy sekretów zaczynające się od
`SUPABASE_`. Funkcja i mirror używają teraz `MESSAGE_INGEST_TOKEN`, zachowując
fallback do `SUPABASE_INGEST_TOKEN` dla istniejącej konfiguracji hostowanej.

## 10. message-archive read tests

`MESSAGE ARCHIVE E2E: PASS`

Przez lokalną Edge Function przeszły:

- `op=latest`, także filtrowany METAR EPIR,
- `op=recent` dla dwóch TAF,
- `op=range` dla pięciu wierszy,
- `op=day` dla pięciu wierszy,
- `op=search` z typami, stacją, flagą FG, widzialnością i QNH,
- `op=stations` z pięcioma stacjami, w tym ICAO EPIR i WMO 12342,
- `op=status` z count 5.

Zweryfikowano projekcję FG/BR/MIFG, widzialność 800 m, wiatr 240/8 kt,
QNH 1018 hPa, ceiling 200 ft i `archive_time`.

## 11. End-to-end ingest/read

Pełna ścieżka przeszła:

`payload mirror -> message-ingest -> ingest_message_batch -> public.messages -> message-archive -> PrognozaEPIRMessageArchive`.

Sprawdzono latest METAR/SPECI EPIR, TAF EPIR, SYNOP 12342, neighbor TAF EPBY
oraz zachowanie powtórzeń i konfliktów. Deno 2.1.4 wykonało `check` dla obu
Edge Functions.

## 12. Retention tests

`RETENTION: PASS`

- Sztuczne stare wiersze utworzono dla EPIR, 12342, EPBY, EPKS i EPPW.
- EPIR i 12342 nigdy nie były eligible.
- EPBY, EPKS i EPPW były eligible według reguły alternate stations.
- Lokalna baza miała około 2.25% limitu, więc funkcja poprawnie wybrała
  `mode=none` i nie usuwała danych.
- `message_retention_log` otrzymał wpis z `deleted_rows=0`.
- Konkurencyjne wywołanie z timeoutem 750 ms zostało zablokowane na
  `pg_advisory_xact_lock(640219026, 1)`.
- Nie uruchomiono retencji na produkcji.

## 13. Sync / storage scripts

`sync_supabase_messages_to_git.py` w realnym lokalnym dry-run pobrał cztery
typy (METAR, SPECI, SYNOP, TAF) przez `/functions/v1/message-archive` i
znormalizował 4/4. `repository_storage_guard.fetch_remote_keys` pobrał 1006
kluczy EPBY przez ten sam endpoint.

Test paginacji Edge potwierdził:

- `count=1006`, `limit=1000`, `offset=0`, 1000 wierszy,
- `count=1006`, `limit=1000`, `offset=1000`, 6 wierszy,
- `count=1006`, `limit=3`, `offset=2`, 3 wiersze.

Skrypty i testy nie używają `/rest/v1/messages`.

## 14. Existing schema compatibility

`EXISTING SCHEMA COMPATIBILITY: PASS`

Ocena opiera się na:

- read-only katalogach rzeczywistego projektu,
- agregatach weryfikujących wszystkie constraints objęte migracją,
- lokalnej kopii dokładnych typów, generated columns, kluczy, polityk,
  grants, legacy WMO i time-aware duplicates,
- rzeczywistym wykonaniu migracji oraz RPC na tej kopii.

Migracja nie próbuje tworzyć globalnej unikalności `content_hash`, która
zniszczyłaby poprawne historyczne powtórzenia. Jedyny znany wyjątek danych to
legacy wind direction poza 0..360; pozostawiono go bez transformacji, a check
jest `NOT VALID` dla historii i aktywny dla nowych zapisów.

## 15. Staging remote result

`STAGING REMOTE: NOT AVAILABLE`

Konto ma jeden projekt `PrognozaEPIR`, a lista Supabase development branches
jest pusta. Nie utworzono płatnego brancha ani nowego projektu bez jawnej zgody.
Nie wykonywano testowego deployu na produkcji.

## 16. Regression results

- JavaScript: 15/16 PASS; jedyny FAIL to znany I-14.
- Python: 17/17 PASS.
- `node --check`: 90/90 źródłowych plików JS PASS.
- `python -m py_compile`: 123/123 plików Python PASS.
- Archive boundaries: PASS (77 konsumentów).
- UTC policy: PASS.
- TAF finalizer: PASS.
- Fog observation archive: PASS.
- Supabase contract tests: PASS.
- Pages build: PASS, 7 HTML i 70/70 wygenerowanych JS.
- Pages wiring MessageArchive przed aktywnymi runtime TAF/FOG: PASS.
- Cloudflare: dwa syntax checks i `core.test.mjs` 4/4 PASS.
- Supabase Edge Functions Deno type-check: PASS.

## 17. Known I-14

`tests/fog-physics-vnext.test.js` nadal oczekuje markera
`validated-production-2026-09-15`, podczas gdy runtime zwraca
`physics-state-gated-authoritative-render-2026-09-16`.

To jest dokładnie znany I-14. Nie został zmieniony ani naprawiony w Etapie 1.

## 18. Merge blockers

Brak nowego blokera technicznego dla merge Etapu 1. Brak remote stagingu jest
jawnie zapisanym ograniczeniem, ale wymagany clean-room, read-only production
inspection i test migracji na kopii istniejącego schematu przeszły.

Review powinno szczególnie potwierdzić:

- time-aware dedup zamiast globalnego unique hash,
- pozostawienie legacy wind constraint jako `NOT VALID`,
- przejście na `MESSAGE_INGEST_TOKEN` z kompatybilnym fallbackiem,
- świadome utrzymanie `verify_jwt=false` dla ingest zabezpieczonego własnym
  tokenem.

## 19. Production blockers

`READY FOR PRODUCTION: NO`

- Brak osobnego remote stagingu i testu deploymentu.
- Migracja nie została zastosowana na produkcji.
- Nowa wersja `message-ingest` nie została wdrożona.
- Przed wdrożeniem należy skonfigurować `MESSAGE_INGEST_TOKEN`, wykonać
  schema/count fingerprint, potwierdzić nadal aktualny stan danych i świadomie
  zdecydować o późniejszej normalizacji jednego legacy wind sentinel.
- Wymagana kolejność: migracja DB, smoke test RPC, sekret i Edge ingest,
  ingest/read smoke test, dopiero potem konsumenci frontendowi.

## 20. Rollback plan

1. Przed wdrożeniem zapisać schema fingerprint, migration list, counts,
   indeksy, policies, grants i aktywne wersje Edge Functions.
2. W razie błędu Edge Function przywrócić poprzednią wersję `message-ingest`
   i poprzednią konfigurację sekretu; nie zmieniać `message-archive`.
3. W razie błędu migracji przerwać transakcję. Po commit migracji rollback
   przygotować jako osobną, reviewowaną migrację: usunąć nowe RPC/indeksy/checks
   tylko po analizie zależności. Nie przywracać publicznego direct SELECT bez
   osobnej decyzji bezpieczeństwa.
4. Nie cofać automatycznie WMO 12342 do ICAO. Ewentualny rollback tego wiersza
   wymaga jawnego sprawdzenia referencji i kopii danych.
5. Wiersze utworzone podczas smoke testu oznaczyć jednoznacznym `source_ref`
   i usuwać wyłącznie po zatwierdzonym, wąskim zapytaniu. Nie wykonywać masowego
   delete archiwum.

## Final decision

- CLEAN LOCAL DATABASE: PASS
- EXISTING SCHEMA COMPATIBILITY: PASS
- MESSAGE INGEST E2E: PASS
- MESSAGE ARCHIVE E2E: PASS
- RLS SECURITY: PASS
- WMO 12342: PASS
- RETENTION: PASS
- STAGING REMOTE: NOT AVAILABLE
- READY FOR MERGE: YES
- READY FOR PRODUCTION: NO
