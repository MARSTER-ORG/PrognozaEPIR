# PrognozaEPIR

Multimodelowy meteogram lotniczy dla Inowrocławia.

Strona jest publikowana jako statyczny HTML przez GitHub Pages. Bieżące depesze METAR/SPECI/TAF/SYNOP są odczytywane przez wspólny `message-archive-client.js` z centralnego archiwum. Źródłem live jest zewnętrzny worker Railway pracujący co 5 minut; statyczne `data/messages` na GitHub Pages pozostaje warstwą zapasową.

Podstrony, w tym generator TAF, nie pobierają depesz bezpośrednio od dostawców meteorologicznych — korzystają wyłącznie z centralnego MessageArchive.
