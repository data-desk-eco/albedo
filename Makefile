# Northern Sea Route Traffic Analysis

include .env
export

all: data/vessel_details.json data/protected_areas.geojson

data/vessel_details.json: scripts/fetch_vessel_data.sh
	@./scripts/fetch_vessel_data.sh

data/protected_areas.geojson: scripts/fetch_protected_areas.sh
	@./scripts/fetch_protected_areas.sh

clean:
	rm -rf data

test:
	@$(MAKE) all START_DATE=2024-01-01 END_DATE=2024-01-31

.PHONY: all clean test
