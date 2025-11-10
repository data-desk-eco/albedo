# Northern Sea Route Traffic Analysis

include .env
export

all: vessel-presence data/protected_areas.geojson

vessel-presence: scripts/fetch_vessel_presence.sh
	@./scripts/fetch_vessel_presence.sh

data/protected_areas.geojson: scripts/fetch_protected_areas.sh
	@./scripts/fetch_protected_areas.sh

convert:
	@./scripts/convert.sh

transform: convert
	cd etl && dbt run --profiles-dir .

tiles: transform
	@./scripts/export_tiles.sh

serve:
	@python3 serve.py

clean:
	rm -rf data

.PHONY: all clean vessel-presence convert transform tiles serve
