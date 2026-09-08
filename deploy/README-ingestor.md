# PrognozaEPIR — centralny ingestor 24/7

Docelowy proces produkcyjny to `scripts/central_ingestor.py`. Jest jedynym automatycznym punktem wejścia dla METAR/SPECI/TAF/SYNOP. Skrypty źródłowe są adapterami wewnętrznymi; autorytatywny zapis wykonuje `scripts/message_archive.py` do `data/messages`.

## Zalecany host

Mały Linux/VPS wystarcza. Repozytorium powinno znajdować się w `/opt/prognozaepir`, a użytkownik `prognozaepir` musi mieć prawo zapisu do tego katalogu oraz uwierzytelnienie Git pozwalające na push do `main` (najlepiej osobny deploy key/token o minimalnych uprawnieniach).

## Instalacja systemd

```bash
sudo useradd --system --home /opt/prognozaepir --shell /usr/sbin/nologin prognozaepir || true
sudo install -d -o prognozaepir -g prognozaepir /opt/prognozaepir
# sklonuj repo do /opt/prognozaepir i skonfiguruj uwierzytelnienie Git dla tego użytkownika
sudo cp deploy/systemd/prognozaepir-ingest.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now prognozaepir-ingest.service
```

Kontrola:

```bash
systemctl status prognozaepir-ingest.service
journalctl -u prognozaepir-ingest.service -f
cat /var/lib/prognozaepir/ingest-state.json
```

Proces działa co 120 s, ma timeouty per źródło, retry z backoffem, blokadę pojedynczego lokalnego writera, walidację archiwum i automatyczny restart przez systemd. Awaria jednego źródła nie zatrzymuje pozostałych. GitHub Actions pozostaje zapasowym schedulerem i używa dokładnie tego samego `central_ingestor.py`; heartbeat-y są wyłącznie watchdogami i nie zapisują archiwum samodzielnie.

## Frontend

`message-archive-client.js` czyta wyłącznie `data/messages`. Nie ma fallbacku do IMGW/AWC/PilotHub w przeglądarce. `scripts/check_archive_boundaries.py` blokuje w CI ponowne dodanie bezpośredniego pobierania depesz do HTML/JS/API.
