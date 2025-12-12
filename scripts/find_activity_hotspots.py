#!/usr/bin/env python3
"""
Find areas with significantly increased vessel activity in 2024 vs 2022-2023.

Uses DuckDB spatial extension to:
1. Compare activity levels by grid cell across years
2. Cluster nearby high-growth cells using coarse grid aggregation
3. Output as JSON for the places of interest dropdown
"""

import duckdb
import json
import os
from pathlib import Path

# Configuration
DB_PATH = os.environ.get("DB_PATH", "data/data.duckdb")
OUTPUT_PATH = os.environ.get("OUTPUT_PATH", "data/places/activity_hotspots.json")
MIN_GROWTH_RATIO = float(os.environ.get("MIN_GROWTH_RATIO", "10.0"))  # Target year must be 10x baseline
MIN_HOURS_TARGET = float(os.environ.get("MIN_HOURS_TARGET", "100"))  # Minimum activity in target year
MAX_BASELINE_AVG = float(os.environ.get("MAX_BASELINE_AVG", "10"))  # Max baseline to exclude established routes
CLUSTER_GRID_SIZE = float(os.environ.get("CLUSTER_GRID_SIZE", "0.5"))  # 0.5° grid for tighter clustering
MIN_CLUSTER_CELLS = int(os.environ.get("MIN_CLUSTER_CELLS", "3"))  # Minimum fine cells per cluster
BASELINE_YEARS = int(os.environ.get("BASELINE_YEARS", "2"))  # Number of previous years for baseline

# Study area bounds (Northern Sea Route / Russian Arctic)
MIN_LAT = float(os.environ.get("MIN_LAT", "65.0"))  # Focus on Arctic
MAX_LAT = float(os.environ.get("MAX_LAT", "85.0"))
MIN_LON = float(os.environ.get("MIN_LON", "30.0"))  # Barents Sea to Bering Strait
MAX_LON = float(os.environ.get("MAX_LON", "180.0"))


def find_hotspots():
    """Find and cluster areas with significant activity increases."""

    con = duckdb.connect(DB_PATH, read_only=True)
    con.execute("INSTALL spatial; LOAD spatial;")

    # Get available years and determine target/baseline
    years_result = con.execute(
        "SELECT DISTINCT year FROM vessel_positions ORDER BY year DESC"
    ).fetchall()
    available_years = [r[0] for r in years_result]

    target_year = available_years[0]
    baseline_years = available_years[1:1 + BASELINE_YEARS]

    print(f"  Target year: {target_year}")
    print(f"  Baseline years: {baseline_years}")

    # Build dynamic SQL for baseline sum
    baseline_sum = " + ".join([f"hours_{y}" for y in baseline_years])
    baseline_cases = "\n            ".join([
        f"SUM(CASE WHEN year = {y} THEN total_hours ELSE 0 END) as hours_{y},"
        for y in baseline_years
    ])

    query = f"""
    WITH yearly_activity AS (
        -- Aggregate hours per grid cell per year
        SELECT
            lat,
            lon,
            year,
            SUM(hours) as total_hours
        FROM vessel_positions
        GROUP BY lat, lon, year
    ),

    pivoted AS (
        -- Pivot to get years as columns
        SELECT
            lat,
            lon,
            {baseline_cases}
            SUM(CASE WHEN year = {target_year} THEN total_hours ELSE 0 END) as hours_target
        FROM yearly_activity
        GROUP BY lat, lon
    ),

    growth_cells AS (
        -- Calculate growth ratio and filter significant increases
        SELECT
            lat,
            lon,
            hours_target,
            ({baseline_sum}) / {len(baseline_years)}.0 as baseline_avg,
            CASE
                WHEN ({baseline_sum}) = 0 THEN
                    CASE WHEN hours_target > 0 THEN 999.0 ELSE 0 END
                ELSE hours_target / (({baseline_sum}) / {len(baseline_years)}.0)
            END as growth_ratio,
            -- Coarse grid cell for clustering
            FLOOR(lat / {CLUSTER_GRID_SIZE}) * {CLUSTER_GRID_SIZE} as cluster_lat,
            FLOOR(lon / {CLUSTER_GRID_SIZE}) * {CLUSTER_GRID_SIZE} as cluster_lon
        FROM pivoted
        WHERE hours_target >= {MIN_HOURS_TARGET}
          AND lat BETWEEN {MIN_LAT} AND {MAX_LAT}
          AND lon BETWEEN {MIN_LON} AND {MAX_LON}
    ),

    high_growth AS (
        -- Filter to cells with significant growth AND low baseline (excludes ports)
        SELECT *
        FROM growth_cells
        WHERE growth_ratio >= {MIN_GROWTH_RATIO}
          AND baseline_avg <= {MAX_BASELINE_AVG}
    )

    -- Aggregate by coarse grid cluster
    SELECT
        cluster_lat,
        cluster_lon,
        COUNT(*) as cell_count,
        SUM(hours_target) as total_hours_target,
        SUM(baseline_avg) as total_baseline_avg,
        AVG(growth_ratio) as avg_growth_ratio,
        MIN(lat) as min_lat,
        MAX(lat) as max_lat,
        MIN(lon) as min_lon,
        MAX(lon) as max_lon,
        -- Weighted center by target year activity
        SUM(lat * hours_target) / SUM(hours_target) as weighted_center_lat,
        SUM(lon * hours_target) / SUM(hours_target) as weighted_center_lon
    FROM high_growth
    GROUP BY cluster_lat, cluster_lon
    HAVING COUNT(*) >= {MIN_CLUSTER_CELLS}
    ORDER BY total_hours_target DESC
    """

    results = con.execute(query).fetchall()
    columns = [
        'cluster_lat', 'cluster_lon', 'cell_count', 'total_hours_target', 'total_baseline_avg',
        'avg_growth_ratio', 'min_lat', 'max_lat', 'min_lon', 'max_lon',
        'weighted_center_lat', 'weighted_center_lon'
    ]

    # Format baseline years for descriptions
    baseline_str = f"{baseline_years[-1]}-{baseline_years[0]}" if len(baseline_years) > 1 else str(baseline_years[0])

    hotspots = []
    for i, row in enumerate(results):
        data = dict(zip(columns, row))

        # Calculate appropriate zoom level based on cluster extent
        lat_extent = data['max_lat'] - data['min_lat']
        lon_extent = data['max_lon'] - data['min_lon']
        extent = max(lat_extent, lon_extent)

        if extent < 0.5:
            zoom = 10
        elif extent < 1:
            zoom = 9
        elif extent < 2:
            zoom = 8
        elif extent < 5:
            zoom = 7
        else:
            zoom = 6

        # Format growth description
        growth = data['avg_growth_ratio']
        if growth >= 999:
            growth_text = f"new activity (none in {baseline_str})"
            growth_text_ru = f"новая активность (отсутствовала в {baseline_str})"
        elif growth >= 10:
            growth_text = f"{growth:.0f}x increase vs {baseline_str}"
            growth_text_ru = f"рост в {growth:.0f} раз по сравнению с {baseline_str}"
        else:
            growth_text = f"{growth:.1f}x increase vs {baseline_str}"
            growth_text_ru = f"рост в {growth:.1f} раза по сравнению с {baseline_str}"

        hours_target = data['total_hours_target']
        if hours_target >= 8760:  # 1 year
            activity_text = f"{hours_target/8760:.1f} vessel-years"
            activity_text_ru = f"{hours_target/8760:.1f} судно-лет"
        elif hours_target >= 720:  # 1 month
            activity_text = f"{hours_target/720:.0f} vessel-months"
            activity_text_ru = f"{hours_target/720:.0f} судно-месяцев"
        else:
            activity_text = f"{hours_target:.0f} vessel-hours"
            activity_text_ru = f"{hours_target:.0f} судно-часов"

        hotspot_num = i + 1
        hotspot = {
            'id': f"hotspot-{hotspot_num}",
            'name_en': f"Activity Hotspot #{hotspot_num}",
            'name_ru': f"Очаг активности #{hotspot_num}",
            'description_en': f"{growth_text}. {activity_text} of activity in {target_year} across {data['cell_count']} grid cells.",
            'description_ru': f"{growth_text_ru}. {activity_text_ru} активности в {target_year} году в {data['cell_count']} ячейках.",
            'center': [
                round(data['weighted_center_lon'], 2),
                round(data['weighted_center_lat'], 2)
            ],
            'zoom': zoom,
            'metadata': {
                'cell_count': data['cell_count'],
                'hours_target': round(data['total_hours_target'], 1),
                'baseline_avg': round(data['total_baseline_avg'], 1),
                'growth_ratio': round(data['avg_growth_ratio'], 2),
                'target_year': target_year,
                'baseline_years': baseline_years,
                'bounds': {
                    'min_lat': round(data['min_lat'], 2),
                    'max_lat': round(data['max_lat'], 2),
                    'min_lon': round(data['min_lon'], 2),
                    'max_lon': round(data['max_lon'], 2)
                }
            }
        }
        hotspots.append(hotspot)

    con.close()
    return hotspots, target_year, baseline_years


def main():
    print(f"Finding activity hotspots in {DB_PATH}...")
    print(f"  Study area: lat {MIN_LAT}°-{MAX_LAT}°, lon {MIN_LON}°-{MAX_LON}°")
    print(f"  Min growth ratio: {MIN_GROWTH_RATIO}x")
    print(f"  Min target hours: {MIN_HOURS_TARGET}")
    print(f"  Max baseline avg: {MAX_BASELINE_AVG} (excludes established routes)")
    print(f"  Cluster grid size: {CLUSTER_GRID_SIZE}° (~{CLUSTER_GRID_SIZE * 111:.0f}km)")
    print(f"  Min cluster cells: {MIN_CLUSTER_CELLS}")

    hotspots, target_year, baseline_years = find_hotspots()

    print(f"\nFound {len(hotspots)} hotspots")

    if hotspots:
        # Show top 5
        print(f"\nTop hotspots by {target_year} activity:")
        for i, h in enumerate(hotspots[:5]):
            print(f"  {i+1}. {h['center']} - {h['metadata']['growth_ratio']}x growth, "
                  f"{h['metadata']['hours_target']:.0f}h in {target_year}")

    # Write JSON output (places format)
    output = {'hotspots': hotspots}
    Path(OUTPUT_PATH).parent.mkdir(parents=True, exist_ok=True)

    with open(OUTPUT_PATH, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"\nWrote {OUTPUT_PATH}")

    # Write GeoJSON output for map highlighting
    geojson_path = OUTPUT_PATH.replace('.json', '.geojson')
    features = []
    for h in hotspots:
        bounds = h['metadata']['bounds']
        # Create polygon from bounds
        coords = [[
            [bounds['min_lon'], bounds['min_lat']],
            [bounds['max_lon'], bounds['min_lat']],
            [bounds['max_lon'], bounds['max_lat']],
            [bounds['min_lon'], bounds['max_lat']],
            [bounds['min_lon'], bounds['min_lat']]
        ]]
        feature = {
            'type': 'Feature',
            'properties': {
                'id': h['id'],
                'name_en': h['name_en'],
                'name_ru': h['name_ru'],
                'description_en': h['description_en'],
                'description_ru': h['description_ru'],
                'hours_target': h['metadata']['hours_target'],
                'growth_ratio': h['metadata']['growth_ratio'],
                'cell_count': h['metadata']['cell_count'],
                'target_year': h['metadata']['target_year']
            },
            'geometry': {
                'type': 'Polygon',
                'coordinates': coords
            }
        }
        features.append(feature)

    geojson = {
        'type': 'FeatureCollection',
        'features': features
    }

    with open(geojson_path, 'w') as f:
        json.dump(geojson, f, indent=2)

    print(f"Wrote {geojson_path}")


if __name__ == '__main__':
    main()
