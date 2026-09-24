# Stage 1 production deployment report

Data zamknięcia: 2026-09-24 UTC

## Status końcowy

Etap 1 audytu PrognozaEPIR został zakończony produkcyjnie po naprawie regresji generatora TAF wykrytej przez live gate.

- Stage 1 rollout SHA, na którym wykryto regresję: `8a98a8ec9e25254d346615180422defca69383cf`.
- Bezpieczny rollback TAF: `7847ecf7fab72d30f06c5702f66daf7b1fe5a1ed`.
- Finalny merge naprawy TAF: `ff65b83888d99d5cc95531d9c896b8d3ba9037a1` (PR #54).
- GitHub Pages wdrożył dokładnie `ff65b83888d99d5cc95531d9c896b8d3ba9037a1`; workflow `35940748446` zakończył się sukcesem.
- Kolejne automatyczne commity `main` po merge dotyczą danych operacyjnych/learning i nie zmieniają runtime Stage 1.

## TAF — regresja i naprawa

Pierwszy produkcyjny gate odrzucił wygenerowaną grupę `TEMPO ... -RA FG`, ponieważ zgodnie z formalnym walidatorem TEMPO nie może wprowadzać pojawienia się FG.

Przyczyna była w `taf-engine-v2.js`: `fogFamily()` rozpoznawała rodzinę zjawiska tylko na podstawie pierwszego tokenu zwróconego przez `weatherToken()`. Przy jednoczesnym opadzie i mgle lista zjawisk miała postać `-RA, FG`; pierwszy token `-RA` ukrywał obecność FG podczas decyzji o TEMPO, chociaż payload emitował oba zjawiska.

Naprawa powoduje, że `fogFamily()` analizuje wszystkie tokeny `weatherTokens()` i nadaje priorytet obecności FG, a następnie BR. Formalnego walidatora nie osłabiono.

Dodano dedykowany test `tests/taf-fg-tempo-regression.test.js` oraz workflow `.github/workflows/taf-fg-tempo-regression.yml`. Test odtwarza jednoczesne `-RA + FG` i potwierdza, że onset FG/BR nie przechodzi przez TEMPO.

Przywrócono również dokładnie wcześniej reviewowaną politykę TAF: generator używa Fog vNext-only; Legacy pozostaje poza wyborem generatora TAF.

## Walidacja produkcyjna TAF / Pages

PR #54 przeszedł wszystkie bramki:

- Enforce global UTC policy — PASS,
- Shared UI validation — PASS,
- TAF Engine 2.4.3 / Instruction 11.2023 compliance — PASS,
- TAF fog onset regression — PASS,
- Deploy PrognozaEPIR to GitHub Pages — PASS.

Po merge workflow Pages `35940748446` zakończył sukcesem zarówno build, jak i deploy. Live verification potwierdził obecność integracji Fog 2.4.4 / TAF 2.4.3, a browser smoke test potwierdził działające cykle UTC i generację godzinowych danych TAF.

## I-14

I-14 jest rozwiązany. Canonical calibration status Fog vNext to:

`physics-state-gated-authoritative-render-2026-09-16`

Runtime i test oczekują tego samego kontraktu.

## Supabase / MessageArchive

Projekt produkcyjny: `PrognozaEPIR`, ref `qozgntzeormujmqzkkmd`.

Po wcześniejszym wdrożeniu Stage 1 pozostają aktywne:

- `message-ingest` — ACTIVE, version 8, własna autoryzacja ingest tokenem, `verify_jwt=false`,
- `message-archive` — ACTIVE, version 8.

Aktualny odczyt produkcyjny po wdrożeniu:

- `messages`: 35 251,
- `stations`: 5,
- `message_sources`: 11,
- `12342`: jeden canonical rekord `wmo='12342'`, `icao=NULL`,
- RLS na `messages` i `stations`: włączone,
- brak bezpośrednich grantów tabel `messages` / `stations` dla `anon` i `authenticated`,
- jeden historyczny rekord kierunku wiatru pozostaje poza 0..360,
- `messages_wind_direction_chk` pozostaje świadomie `NOT VALID` dla historii, ale chroni nowe zapisy.

METAR i TAF są nadal dopisywane do Supabase. Brak świeższego SYNOP 12342 nie jest awarią ingestu Stage 1: Railway regularnie wykonuje `synop-supplement`, a źródło Ogimet zwraca `SYNOP 12342 not present in the current Poland-wide Ogimet window`.

## Railway

Projekt `PrognozaEPIR-Ingestor`, service `central-ingestor`:

- 1 replika,
- latest deployment: `SUCCESS`,
- brak pending work.

Nie był wymagany kolejny redeploy przy naprawie TAF, ponieważ zmiana dotyczyła runtime GitHub Pages.

## Historyczny wind sentinel

Historycznej wartości reprezentowanej wcześniej jako `39006KT` nie zmieniano automatycznie. Zachowano raw/normalized message history i constraint kierunku wiatru pozostaje `NOT VALID`.

Normalna produkcja działa z ochroną nowych zapisów. Pełny historyczny backfill pozostaje zablokowany do czasu świadomej normalizacji tego pojedynczego przypadku i ewentualnego `VALIDATE CONSTRAINT`.

## Rollback

Rollback był wymagany po pierwszej nieudanej próbie wdrożenia TAF i został wykonany skutecznie. Po naprawie PR #54 i finalnym merge nie był wymagany kolejny rollback.

## Decyzja końcowa

- STAGE 1 CODE: PASS
- ALL TESTS: PASS
- I-14: RESOLVED
- MERGED TO MAIN: YES
- SUPABASE MIGRATION: PASS
- MESSAGE INGEST DEPLOYED: YES
- PRODUCTION INGEST: PASS
- MESSAGE ARCHIVE: PASS
- RLS SECURITY: PASS
- WMO 12342: PASS
- GITHUB PAGES: PASS
- TAF PRODUCTION: PASS
- FOG PRODUCTION: PASS
- ROLLBACK REQUIRED: NO
- READY FOR NORMAL PRODUCTION: YES
- READY FOR FULL HISTORICAL BACKFILL: NO
- STAGE 1 COMPLETE: YES

Etap 2 nie jest częścią tego wdrożenia i nie został rozpoczęty w ramach tego zamknięcia.
