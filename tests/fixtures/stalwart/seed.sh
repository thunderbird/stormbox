#!/usr/bin/env bash
# Wait for the Stalwart instance defined in docker-compose.yml to come
# online. The recovery admin (admin/admin-pass-test) is provisioned by
# Stalwart itself when STALWART_RECOVERY_ADMIN is set; this script does
# not need to create accounts.
#
# Usage: bash seed.sh

set -euo pipefail

HOST="${STALWART_HOST:-http://localhost:18080}"

echo "Waiting for Stalwart at $HOST ..."
for _ in $(seq 1 60); do
  if curl -fsS -L -u admin:admin-pass-test -o /dev/null "$HOST/.well-known/jmap"; then
    echo "Stalwart is responding to JMAP session requests."
    exit 0
  fi
  sleep 1
done

echo "Stalwart did not become reachable in time" >&2
exit 1
