# EPIR bulk archive inbox

Wrzucaj tutaj źródłowe eksporty archiwalne EPIR. Importer obsługuje tabele Markdown, tekst TSV/CSV, zwykły tekst/logi oraz skompresowane pliki `.tsv.bz2.b64`.

Rozpoznawane depesze: `METAR`, `SPECI`, `AAXX` (SYNOP) i `TAF`, w tym `TAF AMD`, `TAF COR` oraz anulowania `CNL`.

Rozpoznawane znaczniki czasu obejmują m.in. `YYYY-MM-DD HH:MM`, ISO-8601 oraz `DD.MM.YYYY HH:MM`. Jeśli w wierszu nie ma pełnej daty, importer może użyć daty z nazwy pliku i czasu zakodowanego w `DDHHMMZ` / `DDHH1`.

Wyjście jest idempotentne: ponowny import tego samego zakresu nie dubluje rekordów. Dane trafiają do dziennych archiwów JSONL:

- `data/observations/metar/YYYY/MM/DD.jsonl`
- `data/observations/synop/YYYY/MM/DD.jsonl`
- `data/taf/archive/YYYY/MM/DD.jsonl`
