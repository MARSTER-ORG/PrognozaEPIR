# PrognozaEPIR

Multimodelowy meteogram lotniczy dla Inowrocławia.

Strona jest publikowana jako statyczny HTML przez GitHub Pages. Bieżące depesze METAR/SPECI/TAF/SYNOP są odczytywane przez wspólny `message-archive-client.js` z centralnego archiwum. Źródłem live jest zewnętrzny worker Railway: pełny cykl pozyskania działa co 5 minut, a lekki probe oficjalnego IMGW Aviation API dla METAR/SPECI działa domyślnie co 60 sekund. Statyczne `data/messages` na GitHub Pages pozostaje warstwą zapasową/mirrorem.

Podstrony, w tym generator TAF, nie powinny pobierać depesz bezpośrednio od dostawców meteorologicznych — korzystają z centralnego MessageArchive. Silniki wymagające bieżącej obserwacji powinny również korzystać z `message-archive-client.js`, a nie bezpośrednio z pliku mirror `data/messages/latest.json`.
