#!/bin/sh
set -eu

PERSIST_ROOT="${PROGNOZAEPIR_PERSIST_ROOT:-/app/persistent}"
PERSIST_ARCHIVE="$PERSIST_ROOT/messages"
SEED_ARCHIVE="/app/data/messages"
MARKER="$PERSIST_ROOT/.messages-initialized"

mkdir -p "$PERSIST_ARCHIVE"

# First start with a fresh Railway Volume: seed it with the complete archive
# shipped in the deployment image. This prevents a new mount from hiding the
# historical data that already exists in the repository.
if [ ! -f "$MARKER" ]; then
  if [ -d "$SEED_ARCHIVE" ]; then
    cp -a "$SEED_ARCHIVE"/. "$PERSIST_ARCHIVE"/
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
  echo "[persistent-archive] initialized $PERSIST_ARCHIVE from image seed"
else
  echo "[persistent-archive] reusing existing Railway Volume at $PERSIST_ARCHIVE"
fi

# All existing archive code uses /app/data/messages. Replace only the ephemeral
# image directory with a symlink to the persistent volume before Python starts.
rm -rf "$SEED_ARCHIVE"
ln -s "$PERSIST_ARCHIVE" "$SEED_ARCHIVE"

exec python scripts/railway_opera_server.py
