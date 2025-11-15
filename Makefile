# Northern Sea Route Traffic Analysis

include .env
export

all: vessel-presence data/protected_areas.geojson data/ne_10m_land/ne_10m_land.shp

install:
	uv venv
	uv pip install -r requirements.txt

vessel-presence: scripts/fetch_vessel_presence.sh
	@./scripts/fetch_vessel_presence.sh

data/protected_areas.geojson: scripts/fetch_protected_areas.sh
	@./scripts/fetch_protected_areas.sh

data/ne_10m_land/ne_10m_land.shp: scripts/fetch_land.sh
	@./scripts/fetch_land.sh

convert:
	@./scripts/convert.sh

transform: convert
	cd etl && dbt run --profiles-dir .

tiles: transform
	@./scripts/export_tiles.sh

serve:
	@uv run python scripts/tile_server.py

clean:
	rm -rf data

.PHONY: all clean vessel-presence convert transform tiles serve install
