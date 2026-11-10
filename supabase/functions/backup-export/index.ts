import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const TABLES: Record<string,string> = {
  message_sources: "code",
  stations: "icao",
  messages: "id",
  ingest_runs: "id",
  forecasts: "id",
  forecast_verifications: "id",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "access-control-allow-origin": "*",
  },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type" } });
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });
  const u = new URL(req.url);
  const op = (u.searchParams.get("op") || "manifest").toLowerCase();

  try {
    if (op === "schema") {
      const { data, error } = await db.rpc("backup_schema_snapshot");
      if (error) throw error;
      return json({ ok: true, schema: data });
    }

    if (op === "table") {
      const table = (u.searchParams.get("table") || "").toLowerCase();
      const order = TABLES[table];
      if (!order) return json({ ok: false, error: "table_not_allowed" }, 400);
      const offset = Math.max(0, Number.parseInt(u.searchParams.get("offset") || "0", 10) || 0);
      const limit = Math.min(1000, Math.max(1, Number.parseInt(u.searchParams.get("limit") || "1000", 10) || 1000));
      // Keyset pagination bounded by the manifest high-water mark prevents
      // new ingest rows from changing the snapshot while pages are exported.
      // The offset API is retained for legacy callers.
      const keyset = u.searchParams.has("max_id");
      let query = db.from(table).select("*", { count: "exact" });
      if (keyset) {
        const maxId = u.searchParams.get("max_id");
        if (!maxId) return json({ ok: false, error: "max_id_required" }, 400);
        query = query.lte("id", maxId).order("id", { ascending: true }).limit(limit);
        const after = u.searchParams.get("after");
        if (after) query = query.gt("id", after);
      } else {
        query = query.order(order, { ascending: true }).range(offset, offset + limit - 1);
      }
      const { data, error, count } = await query;
      if (error) throw error;
      return json({ ok: true, table, offset, limit, count: count ?? null, rows: data ?? [] });
    }

    if (op === "manifest") {
      const counts: Record<string, number | null> = {};
      const maxIds: Record<string, string | null> = {};
      for (const table of Object.keys(TABLES)) {
        // Freeze the upper PK boundary before counting each table.
        const { data: latest, error: maxError } = await db.from(table)
          .select("id").order("id", { ascending: false }).limit(1);
        if (maxError) throw maxError;
        const maxId = latest?.[0]?.id == null ? null : String(latest[0].id);
        maxIds[table] = maxId;
        let countQuery = db.from(table).select("*", { count: "exact", head: true });
        if (maxId !== null) countQuery = countQuery.lte("id", maxId);
        const { count, error } = await countQuery;
        if (error) throw error;
        counts[table] = count ?? null;
      }
      return json({ ok: true, generated_at: new Date().toISOString(), tables: counts, max_ids: maxIds });
    }

    return json({ ok: false, error: "unsupported_op" }, 400);
  } catch (error) {
    return json({ ok: false, error: String((error as any)?.message || error) }, 500);
  }
});
