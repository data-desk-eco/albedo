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
	./scripts/fetch_buffer_zones.sh
	./scripts/fetch_land.sh
	./scripts/fetch_places.sh
	@touch $@

# Fetch sanctions data from OpenSanctions
sanctions: data/export/sanctioned_mmsi.json

data/export/sanctioned_mmsi.json: scripts/fetch_sanctions.py
	uv run python scripts/fetch_sanctions.py

# Ingest supplementary vessel metadata (build year, DWT, IMO)
vessel-metadata: data/data.duckdb
	uv run python scripts/ingest_vessel_metadata.py

# Convert GFW JSON to Parquet
convert: data/.convert.done

data/.convert.done: data/.fetch.done
	./scripts/convert.sh
	@touch $@

# Run SQL transformations (replaces dbt)
transform: data/data.duckdb

data/data.duckdb: data/.convert.done etl/transform.sql
	duckdb $@ < etl/transform.sql

# Generate COGs with land mask (aggregate + per-vessel-type)
tiles: data/vessel_heatmap.tif

data/vessel_heatmap.tif: data/data.duckdb
	./scripts/export_raster.sh
	@echo "Generated COGs:" && ls -lh data/vessel_heatmap*.tif

# Export client-side data files (manifest + PMTiles + vessel tooltips)
export: data/export/.done

data/export/.done: data/data.duckdb manifest.template.json .env
	node scripts/export_manifest.js
	./scripts/export_pmtiles.sh
	uv run python scripts/export_tiles.py
	uv run python scripts/export_buffer_zones.py
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
	rm -rf dist data/data.duckdb data/export data/vessel_heatmap*.tif

#───────────────────────────────────────────────────────────────────────────────
# Deployment
# All data files served from GCS (COGs, PMTiles, manifest, vessel data)
#───────────────────────────────────────────────────────────────────────────────

GCS_BUCKET := albedo-data
GCS_URL := https://storage.googleapis.com/$(GCS_BUCKET)

# Deploy data files to GCS
deploy-data: data/vessel_heatmap.tif data/export/.done
	gcloud storage cp data/vessel_heatmap*.tif gs://$(GCS_BUCKET)/
	gcloud storage cp data/export/vessel_data.bin gs://$(GCS_BUCKET)/
	gcloud storage cp data/export/vectors.pmtiles gs://$(GCS_BUCKET)/
	gcloud storage cp data/export/manifest.json gs://$(GCS_BUCKET)/
	gcloud storage cp -r data/export/i18n gs://$(GCS_BUCKET)/
	gcloud storage cp data/export/sanctioned_mmsi.json gs://$(GCS_BUCKET)/
	gcloud storage cp data/export/sanctions_details.json gs://$(GCS_BUCKET)/
	gcloud storage cp data/export/buffer_zones.geojson gs://$(GCS_BUCKET)/
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

.PHONY: all fetch convert transform tiles export sanctions vessel-metadata install dev build preview clean deploy-data setup-gcs
