# PrognozaEPIR — odzyskiwanie po wyczerpaniu GitHub Actions (2 listopada 2026)

## Zweryfikowana infrastruktura
- Aktualne dane METAR, TAF, SPECI i SYNOP są zapisywane do projektu Supabase `qozgntzeormujmqzkkmd`.
- `Railway / PrognozaEPIR-Ingestor / central-ingestor-cron` działa według harmonogramu `*/5 * * * *`.
- `Supabase pg_cron` wykonuje istniejący fallback TAF w odstępach 20 minut. Sukces samego zadania SQL nie gwarantuje, że nowy TAF został opublikowany.
- Interfejs archiwum `message-archive-client.js` korzysta bezpośrednio z Supabase, z zapasowymi odczytami plików.
- Zadania GitHub Actions przestały startować po wyczerpaniu minut; ostatnie błędy następowały przed przydzieleniem runnera.

## Wdrażana zmiana
- `.github/workflows/mirror-central-archive.yml`: tylko `workflow_dispatch`; synchronizacja plików GitHub z Supabase nie jest konieczna dla bieżącego archiwum. Pliki w repozytorium mogą być starsze niż dane w Supabase.
- `scripts/railway_ingestor_event_server.py`: `GITHUB_ARCHIVE_DISPATCH_ENABLED` ma domyślną wartość `0`. Jeśli kiedyś trzeba wznowić kopię na GitHub, trzeba świadomie ustawić `1` i przywrócić harmonogram.
- Meteogram: sprawdzanie pokrycia 48/72/120 h dla temperatury, wilgotności, ciśnienia, wiatru, widzialności i pionowego profilu chmur; wyświetlanie braków zamiast etykiety LIVE; brak interpolowania zerowej widzialności z `null`.

## Kolejne kroki operacyjne
1. Uruchomić `node tests/meteogram-coverage.test.js` oraz dotychczasowe testy JavaScript i Python.
2. Sprawdzić kompilację strony `python3 scripts/prepare_pages_v241.py` i `python3 scripts/wire_fog_mifg_utc_runtime.py`, także testy integracji warstwy FOG.
3. Przed scaleniem ocenić konfigurację GitHub Pages. Aktualne `pages-v2.yml` buduje `_site` i wymaga Actions; samo scalenie zmian w źródle nie publikuje automatycznie poprawionego meteogramu, jeśli Actions są zablokowane.
4. Alternatywa bez GitHub-hosted runnera: przenieść skompilowaną statyczną stronę na hosting z zewnętrznym systemem build, albo skonfigurować publikowanie z gałęzi. Trzeba najpierw zapewnić, że skrypty `prepare_pages_v241.py` i `wire_fog_mifg_utc_runtime.py` wykonają się poza GitHub Actions.
5. Historyczne zadania uczenia i reanaliz (Fog LEGACY, model snapshot, previous-runs) **nie zostały** jeszcze przeniesione do Railway. Zachować je jako ręczne zadania do czasu osobnego audytu zależności i kosztów.
6. W przypadku deployu Railway sprawdzić nowe logi oraz ustawienie flagi `GITHUB_ARCHIVE_DISPATCH_ENABLED`; zmiany kodu w GitHub nie zmieniają samodzielnie uruchomionego obrazu Railway.
7. Zweryfikować osobno pobieranie i poprawność danych każdego okresu 48/72/120 h; pustych odcinków nie wolno wypełniać fikcyjną prognozą.

## Bezpieczeństwo
Bez nowego płatnego zasobu, bez zmiany RLS, bez usuwania depesz. Nigdy nie publikować sekretów SUPABASE_INGEST_TOKEN ani GITHUB_ARCHIVE_DISPATCH_TOKEN w klientach WWW.
