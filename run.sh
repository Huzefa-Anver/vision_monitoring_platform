#!/usr/bin/env bash
# Start the sack labelling platform. Settings come from .env (see .env.example).
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a
exec "${PYTHON:-python3}" src/sack_platform/app.py
