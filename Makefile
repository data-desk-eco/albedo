# Albedo - Northern Sea Route Traffic Analysis

include .env
export

all: vessel-presence data/protected_areas.geojson data/ne_10m_land/ne_10m_land.shp data/ne_10m_populated_places/ne_10m_populated_places.shp

install:
	uv sync

vessel-presence: scripts/fetch_vessel_presence.sh
	@./scripts/fetch_vessel_presence.sh

data/protected_areas.geojson: scripts/fetch_protected_areas.sh
	@./scripts/fetch_protected_areas.sh

data/ne_10m_land/ne_10m_land.shp: scripts/fetch_land.sh
	@./scripts/fetch_land.sh

data/ne_10m_populated_places/ne_10m_populated_places.shp: scripts/fetch_places.sh
	@./scripts/fetch_places.sh

convert:
	@./scripts/convert.sh

transform: convert
	cd etl && dbt run --profiles-dir .

tiles: transform
	@./scripts/export_tiles.sh

serve:
	@uv run python scripts/tile_server.py

static:
	@./scripts/build_static.sh

clean:
	rm -rf data

# Quick iteration targets (skip long-running data fetching/transforms)
# Regenerate just the raster heatmap from existing DuckDB data
raster:
	@./scripts/export_tiles.sh

# Restart tile server (for testing tile_server.py changes)
restart:
	@pkill -f tile_server.py || true
	@sleep 1
	@uv run python scripts/tile_server.py &
	@echo "Tile server restarted at http://localhost:8000"

# Watch for changes and auto-reload (requires entr: brew install entr)
watch:
	@echo "Watching for changes... (Ctrl+C to stop)"
	@find scripts/tile_server.py index.html | entr -r make restart

# Cloud Run deployment
PROJECT_NAME := albedo
GCP_PROJECT := data-desk-web
REGION := europe-west1
DOMAIN := tools.datadesk.eco

deploy:
	@echo "🚀 Deploying $(PROJECT_NAME) to Cloud Run..."
	@gcloud run deploy $(PROJECT_NAME) \
		--source . \
		--region $(REGION) \
		--project $(GCP_PROJECT) \
		--allow-unauthenticated \
		--port 8080 \
		--max-instances 10 \
		--min-instances 0 \
		--memory 1Gi \
		--cpu 1 \
		--quiet
	@echo ""
	@echo "✅ Deployment complete!"
	@echo "🌐 Live at: $$(gcloud run services describe $(PROJECT_NAME) --region $(REGION) --project $(GCP_PROJECT) --format 'value(status.url)')"
	@echo "🔓 App is publicly accessible"
	@echo ""
	@echo "To map custom domain $(PROJECT_NAME).$(DOMAIN):"
	@echo "  Run: make domain"

update:
	@gcloud run deploy $(PROJECT_NAME) \
		--source . \
		--region $(REGION) \
		--project $(GCP_PROJECT) \
		--allow-unauthenticated \
		--quiet
	@echo "✓ App updated"

url:
	@echo "Direct Cloud Run URL:"
	@gcloud run services describe $(PROJECT_NAME) \
		--region $(REGION) \
		--project $(GCP_PROJECT) \
		--format 'value(status.url)'
	@echo ""
	@echo "Custom domain: https://$(PROJECT_NAME).$(DOMAIN)"

logs:
	@gcloud run logs read \
		--service $(PROJECT_NAME) \
		--region $(REGION) \
		--project $(GCP_PROJECT) \
		--limit 50

domain:
	@echo "Setting up domain mapping for $(PROJECT_NAME).$(DOMAIN)..."
	@gcloud run domain-mappings create \
		--service $(PROJECT_NAME) \
		--domain $(PROJECT_NAME).$(DOMAIN) \
		--region $(REGION) \
		--project $(GCP_PROJECT) || echo "Domain mapping may already exist"
	@echo "✅ Domain mapping configured"
	@echo "Add these DNS records:"
	@gcloud run domain-mappings describe $(PROJECT_NAME).$(DOMAIN) \
		--region $(REGION) \
		--project $(GCP_PROJECT) \
		--format="value(status.resourceRecords)"

.PHONY: all clean vessel-presence convert transform tiles serve static install deploy update url logs domain raster restart watch
