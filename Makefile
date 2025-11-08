# Northern Sea Route Traffic Analysis

include .env
export

all: data/gfw data/protected_areas.geojson

data/gfw: scripts/fetch_vessel_presence.sh
	@./scripts/fetch_vessel_presence.sh

data/protected_areas.geojson: scripts/fetch_protected_areas.sh
	@./scripts/fetch_protected_areas.sh

clean:
	rm -rf data

test:
	@$(MAKE) all START_DATE=2024-01-01 END_DATE=2024-01-31

.PHONY: all clean test
