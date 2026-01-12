-- Vessel points for interactive tooltips
-- Matches raster grid (0.01°) - shows dominant vessel per cell
-- Used for hover tooltips on the heatmap

{{ config(materialized='table') }}

WITH vessel_hours_per_cell AS (
    -- Sum hours per vessel per grid cell per year
    SELECT
        vessel_id,
        mmsi,
        ship_name,
        flag,
        vessel_type,
        gear_type,
        year,
        lat,
        lon,
        sum(hours) as total_hours
    FROM {{ ref('vessel_positions') }}
    GROUP BY vessel_id, mmsi, ship_name, flag, vessel_type, gear_type, year, lat, lon
),

ranked AS (
    -- Rank vessels by hours within each cell+year
    SELECT
        *,
        row_number() OVER (
            PARTITION BY lat, lon, year
            ORDER BY total_hours DESC
        ) as rank
    FROM vessel_hours_per_cell
)

-- Keep only the dominant vessel per cell+year
SELECT
    vessel_id,
    mmsi,
    ship_name,
    flag,
    vessel_type,
    gear_type,
    year,
    lat,
    lon,
    total_hours
FROM ranked
WHERE rank = 1
