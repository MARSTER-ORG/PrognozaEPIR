-- Reduce Supabase message-ingest RPC latency for canonical identity checks.
-- The ingest_message_batch function probes public.messages by content_hash,
-- which cannot efficiently use the existing leading-column composite key.
-- Created CONCURRENTLY in production first to avoid blocking writes.
-- This idempotent migration ensures future environments receive the index.
CREATE INDEX IF NOT EXISTS idx_messages_content_hash
  ON public.messages (content_hash);
