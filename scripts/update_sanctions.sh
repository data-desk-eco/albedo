#!/usr/bin/env bash
# Update OpenSanctions data and optionally deploy to GCS.
#
# Usage:
#   ./scripts/update_sanctions.sh              # Update locally
#   ./scripts/update_sanctions.sh --deploy     # Update + deploy to GCS
#
# Cron example (weekly Sunday 3am):
#   0 3 * * 0 cd /path/to/albedo && ./scripts/update_sanctions.sh --deploy >> logs/sanctions.log 2>&1
#
set -euo pipefail

cd "$(dirname "$0")/.."

# Remove cached CSV to force fresh download
rm -f data/sanctions/targets.simple.csv

echo "$(date '+%Y-%m-%d %H:%M:%S') Fetching OpenSanctions data..."
uv run python scripts/fetch_sanctions.py

if [ "${1:-}" = "--deploy" ]; then
    source .env 2>/dev/null || true
    GCS_BUCKET="${GCS_BUCKET:-albedo-data}"
    echo "$(date '+%Y-%m-%d %H:%M:%S') Deploying to gs://${GCS_BUCKET}/..."
    gcloud storage cp data/export/sanctioned_mmsi.json "gs://${GCS_BUCKET}/"
    gcloud storage cp data/export/sanctions_details.json "gs://${GCS_BUCKET}/"
    echo "$(date '+%Y-%m-%d %H:%M:%S') Deployed successfully."
else
    echo "$(date '+%Y-%m-%d %H:%M:%S') Local update complete. Use --deploy to push to GCS."
fi
