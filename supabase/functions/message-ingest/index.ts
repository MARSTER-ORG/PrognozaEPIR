import { createClient } from "npm:@supabase/supabase-js@2.117.0";
import {
  ContractError,
  MAX_BODY_BYTES,
  normalizeBatch,
} from "./contract.mjs";

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function equalSecret(provided: string, expected: string) {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }
  return difference === 0;
}

Deno.serve(async (request: Request) => {
  const requestId = crypto.randomUUID();
  if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed', request_id: requestId }, 405);

  const ingestToken = Deno.env.get('MESSAGE_INGEST_TOKEN') || Deno.env.get('SUPABASE_INGEST_TOKEN') || '';
  if (!ingestToken) {
    console.error('message-ingest configuration error', { requestId, reason: 'missing ingest token' });
    return json({ ok: false, error: 'service unavailable', request_id: requestId }, 503);
  }
  const providedToken = request.headers.get('x-ingest-token') || '';
  if (!providedToken || !(await equalSecret(providedToken, ingestToken))) {
    return json({ ok: false, error: 'unauthorized', request_id: requestId }, 401);
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return json({ ok: false, error: 'content-type must be application/json', request_id: requestId }, 415);
  }
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'request body is too large', request_id: requestId }, 413);
  }

  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: 'request body is too large', request_id: requestId }, 413);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new ContractError('body is not valid JSON');
    }
    const { rows, repeated } = await normalizeBatch(payload);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      console.error('message-ingest configuration error', { requestId, reason: 'missing service environment' });
      return json({ ok: false, error: 'service unavailable', request_id: requestId }, 503);
    }

    const database = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await database.rpc('ingest_message_batch', { p_messages: rows });
    if (error) {
      const conflict = error.code === '23505';
      console.error('message-ingest database error', {
        requestId,
        code: error.code || null,
        message: error.message || 'unknown database error',
      });
      return json({
        ok: false,
        error: conflict ? 'message identity conflict' : 'database write failed',
        request_id: requestId,
      }, conflict ? 409 : 500);
    }

    const result = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    return json({
      ok: true,
      inserted: Number(result.inserted || 0),
      duplicates: Number(result.duplicates || 0) + repeated,
      request_id: requestId,
    });
  } catch (error) {
    if (error instanceof ContractError) {
      return json({ ok: false, error: error.message, request_id: requestId }, error.status);
    }
    console.error('message-ingest unexpected error', {
      requestId,
      type: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : 'unknown error',
    });
    return json({ ok: false, error: 'internal server error', request_id: requestId }, 500);
  }
});
