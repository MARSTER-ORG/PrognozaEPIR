# EPIR Lightning Alerts · 50 km

Cloudflare Worker odpowiedzialny wyłącznie za alarmy Web Push o nowych wyładowaniach w promieniu 50 km od stałego punktu EPIR (`52.8275, 18.3175`). Telefon nie udostępnia GPS ani lokalizacji.

## Zasada działania

1. Cron uruchamia Worker co minutę (UTC).
2. Worker pobiera istniejący snapshot `MTG LI LFL` używany przez PrognozaEPIR.
3. Każdy nowy punkt jest liczony metodą Haversine względem EPIR.
4. Nowe wyładowanie `<= 50 km` może wywołać Web Push.
5. Anty-flood: standardowy cooldown 10 min. Alarm może pojawić się wcześniej, gdy najbliższe wyładowanie zbliży się o co najmniej 10 km lub przejdzie do bliższej strefy 30/15/10 km.
6. Wszystkie czasy w treści powiadomień są w UTC.

Stan i subskrypcje przechowuje Durable Object, więc nie trzeba tworzyć osobnej bazy D1/KV.

## Wdrożenie Cloudflare

```bash
cd cloudflare/lightning-alert-worker
npm install
npm test
npm run vapid
```

Wygenerowaną parę VAPID wpisz jako sekrety Workera:

```bash
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
npx wrangler secret put ADMIN_TOKEN
```

`VAPID_SUBJECT` powinien mieć formę `mailto:adres@example.com` albo adres HTTPS kontrolowanej witryny. `ADMIN_TOKEN` jest losowym długim tokenem używanym wyłącznie do ręcznego testu `/admin/run`.

Następnie:

```bash
npm run deploy
```

Po wdrożeniu skopiuj adres Workera, np. `https://epir-lightning-alerts.<twoj-subdomain>.workers.dev`, otwórz `lightning-alerts.html` w PrognozaEPIR, wpisz ten adres raz i wybierz **Włącz powiadomienia**.

## Testy

```bash
npm test
npm run check
npm run dev
```

Lokalny Cron można wywołać przez endpoint Wranglera `/cdn-cgi/local/scheduled`.

## API

- `GET /health` — stan usługi,
- `GET /config` — punkt EPIR, promień 50 km i publiczny klucz VAPID,
- `POST /subscribe` — zapis PushSubscription,
- `POST /unsubscribe` — usunięcie PushSubscription,
- `GET /status` — diagnostyka i ostatni wynik sprawdzenia,
- `POST /admin/run` — ręczne sprawdzenie, wymaga `Authorization: Bearer <ADMIN_TOKEN>`.

Źródło LFL jest konfigurowalne przez `LIGHTNING_FEED_URL`, więc późniejsza migracja źródła poza Railway nie wymaga zmian algorytmu alarmów.
