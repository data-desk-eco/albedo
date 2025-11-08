# Northern Sea Route shipping map

Map of shipping activity along Russia's Northern Sea Route. Consultancy project for Arctida.

## Setup

```bash
make           # Fetch all data (2021-2024)
make test      # Quick test (Jan 2024)
make clean     # Remove data
```

Configuration in `.env` — edit to change date ranges, study area, etc.

## Data sources

- **Vessels**: [GFW 4Wings API](https://globalfishingwatch.org/our-apis/documentation) (`public-global-presence:latest`)
- **Protected areas**: Russian Ministry of Natural Resources WFS
- **Terms of reference**: `docs/NSR Traffic - Terms of Reference.pdf`

## Output

- `data/vessel_presence.json` — Raw 4Wings API response
- `data/vessel_details.json` — Unique vessels with IMO, MMSI, flags, etc.
- `data/protected_areas.geojson` — Russian Arctic protected areas

## Stack

- Makefile + bash scripts (62 lines total)
- curl + jq for data fetching/transformation
- DuckDB for subsequent analysis
- Final output: static Mapbox/MapLibre map
