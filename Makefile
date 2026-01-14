# Albedo - Static Architecture Build Pipeline
# Zero server compute - all rendering happens in browser

include .env
export

#───────────────────────────────────────────────────────────────────────────────
# Data Pipeline
#───────────────────────────────────────────────────────────────────────────────

# Full pipeline
all: transform tiles export build

# Fetch source data from APIs
fetch: data/.fetch.done

data/.fetch.done:
	./scripts/fetch_vessel_presence.sh
	./scripts/fetch_protected_areas.sh
	./scripts/fetch_land.sh
	./scripts/fetch_places.sh
	@touch $@

# Convert GFW JSON to Parquet
convert: data/.convert.done

data/.convert.done: data/.fetch.done
	./scripts/convert.sh
	@touch $@

# Run SQL transformations (replaces dbt)
transform: data/data.duckdb

data/data.duckdb: data/.convert.done etl/transform.sql
	duckdb $@ < etl/transform.sql

# Generate COG with land mask
tiles: data/vessel_heatmap.tif

data/vessel_heatmap.tif: data/data.duckdb
	./scripts/export_raster.sh

# Export client-side data files
export: data/export/.done

data/export/.done: data/data.duckdb
	./scripts/export_sqlite.sh
	uv run python scripts/export_tiles.py
	@touch $@

#───────────────────────────────────────────────────────────────────────────────
# Development
#───────────────────────────────────────────────────────────────────────────────

install:
	uv sync
	yarn install

# Development server (static files only - no tile server needed)
dev:
	yarn run dev

# Build for production (Vite handles data copying via plugin)
SRC_FILES := $(shell find src -type f 2>/dev/null)
build: dist

dist: $(SRC_FILES) index.html vite.config.js data/export/.done
	yarn run build

# Preview production build locally
preview: build
	yarn run preview

clean:
	rm -rf dist data/data.duckdb data/export data/vessel_heatmap.tif

#───────────────────────────────────────────────────────────────────────────────
# Deployment
# - GitHub Pages (via Actions): HTML/JS/CSS + small parquets
# - GCS: Large files (COG + vessel_lookup) with range request support
#───────────────────────────────────────────────────────────────────────────────

GCS_BUCKET := albedo-data
GCS_URL := https://storage.googleapis.com/$(GCS_BUCKET)

# Deploy large data files to GCS (COG + vessel tiles for range requests)
deploy-data: data/vessel_heatmap.tif data/export/.done
	gcloud storage cp data/vessel_heatmap.tif gs://$(GCS_BUCKET)/
	gcloud storage cp -r data/export/tiles gs://$(GCS_BUCKET)/
	@echo "Deployed to: $(GCS_URL)/"

# Setup GCS bucket with CORS for range requests (run once)
setup-gcs:
	gcloud storage buckets create gs://$(GCS_BUCKET) \
		--location=europe-west1 \
		--uniform-bucket-level-access
	gcloud storage buckets add-iam-policy-binding gs://$(GCS_BUCKET) \
		--member=allUsers \
		--role=roles/storage.objectViewer
	@echo '[ { "origin": ["*"], "method": ["GET", "HEAD"], "responseHeader": ["Content-Type", "Content-Range", "Accept-Ranges", "Content-Length", "Content-Encoding"], "maxAgeSeconds": 3600 } ]' > /tmp/cors.json
	gcloud storage buckets update gs://$(GCS_BUCKET) --cors-file=/tmp/cors.json
	@rm /tmp/cors.json
	@echo "GCS bucket configured with CORS for range requests"

#───────────────────────────────────────────────────────────────────────────────
# Utilities
#───────────────────────────────────────────────────────────────────────────────

# Export vessel crossings as CSV for review
export-crossings: data/vessel_crossings.csv

data/vessel_crossings.csv: data/data.duckdb
	duckdb data/data.duckdb -c "COPY (SELECT feature_id, area_name, vessel_id, mmsi, ship_name, flag, vessel_type, gear_type, total_hours, first_seen, last_seen, year, centroid_lon, centroid_lat, position_count FROM vessel_crossings ORDER BY total_hours DESC) TO 'data/vessel_crossings.csv' (HEADER, DELIMITER ',');"
	@echo "Exported $$(wc -l < data/vessel_crossings.csv | tr -d ' ') rows to data/vessel_crossings.csv"

#───────────────────────────────────────────────────────────────────────────────

.PHONY: all fetch convert transform tiles export install dev build preview clean deploy-data setup-gcs export-crossings
