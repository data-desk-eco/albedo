# Albedo - Northern Sea Route Traffic Analysis

include .env
export

#───────────────────────────────────────────────────────────────────────────────
# Data Pipeline
#───────────────────────────────────────────────────────────────────────────────

# Full pipeline
all: fetch convert transform tiles

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

# Run dbt transformations
transform: data/data.duckdb

data/data.duckdb: data/.convert.done
	cd etl && dbt run --profiles-dir .

# Generate all tiles
tiles: data/vessel_heatmap.tif data/protected_areas.pmtiles data/land.pmtiles data/places.pmtiles data/vessel_crossings.pmtiles

data/vessel_heatmap.tif: data/data.duckdb
	./scripts/export_raster.sh

data/protected_areas.pmtiles: data/data.duckdb data/protected_areas.geojson
	./scripts/export_protected_areas.sh

data/land.pmtiles: data/ne_10m_land/ne_10m_land.shp
	./scripts/export_land.sh

data/places.pmtiles: data/ne_10m_populated_places/ne_10m_populated_places.shp
	./scripts/export_places.sh

data/vessel_crossings.pmtiles: data/data.duckdb
	./scripts/export_crossings.sh

# Export vessel crossings as CSV for review
export-crossings: data/vessel_crossings.csv

data/vessel_crossings.csv: data/data.duckdb
	duckdb data/data.duckdb -c "COPY (SELECT feature_id, area_name, vessel_id, mmsi, ship_name, flag, vessel_type, gear_type, total_hours, first_seen, last_seen, year, centroid_lon, centroid_lat, position_count FROM vessel_crossings ORDER BY total_hours DESC) TO 'data/vessel_crossings.csv' (HEADER, DELIMITER ',');"
	@echo "Exported $$(wc -l < data/vessel_crossings.csv | tr -d ' ') rows to data/vessel_crossings.csv"

#───────────────────────────────────────────────────────────────────────────────
# Development
#───────────────────────────────────────────────────────────────────────────────

install:
	uv sync
	yarn install

serve:
	uv run python scripts/tile_server.py

dev:
	uv run python scripts/tile_server.py & PID=$$!; trap "kill $$PID 2>/dev/null" EXIT INT TERM; yarn dev

build:
	yarn build

clean:
	rm -rf data dist

#───────────────────────────────────────────────────────────────────────────────
# Deployment (Cloud Run)
#───────────────────────────────────────────────────────────────────────────────

PROJECT_NAME := albedo
GCP_PROJECT := data-desk-web
REGION := europe-west1
DOMAIN := tools.datadesk.eco

deploy:
	gcloud run deploy $(PROJECT_NAME) \
		--source . \
		--region $(REGION) \
		--project $(GCP_PROJECT) \
		--allow-unauthenticated \
		--port 8080 \
		--max-instances 10 \
		--min-instances 0 \
		--memory 1Gi \
		--cpu 1
	@echo "Live at: https://$(PROJECT_NAME).$(DOMAIN)"

logs:
	gcloud run logs read --service $(PROJECT_NAME) --region $(REGION) --project $(GCP_PROJECT) --limit 50

#───────────────────────────────────────────────────────────────────────────────

.PHONY: all fetch convert transform tiles export-crossings install serve dev build clean deploy logs
