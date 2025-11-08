-- Northern Sea Route aggregated vessel presence heatmap
-- Enriched with vessel characteristics (fuel type, etc.)

INSTALL spatial;
INSTALL json;
LOAD spatial;
LOAD json;

-- 1. Load all monthly 4Wings API responses
CREATE OR REPLACE TABLE raw_presence AS
SELECT
  regexp_extract(filename, '(\d{4}-\d{2})', 1) AS month,
  unnest(entries, recursive := true)
FROM read_json('data/gfw/*.json', union_by_name := true, filename := true);

-- 2. Load vessel characteristics
CREATE OR REPLACE TABLE vessel_details AS
SELECT *
FROM read_json('data/vessel_details.json');

-- 3. Enrich presence data with vessel characteristics and aggregate by location + fuel type
-- This is the main output: aggregated heatmap data
CREATE OR REPLACE TABLE heatmap AS
SELECT
  -- Spatial aggregation (adjust grid size as needed)
  ROUND(lat, 2) AS lat,  -- ~1km resolution at Arctic latitudes
  ROUND(lon, 2) AS lon,
  ST_Point(ROUND(lon, 2), ROUND(lat, 2)) AS geometry,

  -- Temporal aggregation
  EXTRACT(year FROM timestamp::TIMESTAMP) AS year,
  EXTRACT(month FROM timestamp::TIMESTAMP) AS month,

  -- Vessel characteristics from vessel_details
  v.fuel_type,
  v.vessel_type,
  v.flag,  -- Adjust field names based on actual vessel_details.json structure

  -- Aggregated metrics
  SUM(hours) AS total_hours,
  COUNT(DISTINCT vesselId) AS unique_vessels,
  COUNT(*) AS observations

FROM raw_presence p
LEFT JOIN vessel_details v ON p.vesselId = v.vessel_id  -- Adjust join key
WHERE p.lat IS NOT NULL
  AND p.lon IS NOT NULL
  AND p.lat BETWEEN -90 AND 90
  AND p.lon BETWEEN -180 AND 180
GROUP BY
  ROUND(p.lat, 2),
  ROUND(p.lon, 2),
  EXTRACT(year FROM p.timestamp::TIMESTAMP),
  EXTRACT(month FROM p.timestamp::TIMESTAMP),
  v.fuel_type,
  v.vessel_type,
  v.flag;

-- 4. Export to geoparquet for visualization
COPY heatmap
TO 'data/heatmap.parquet'
(FORMAT PARQUET, COMPRESSION 'zstd');

-- 5. Summary statistics
SELECT
  fuel_type,
  COUNT(DISTINCT unique_vessels) as vessels,
  SUM(total_hours) as hours,
  COUNT(*) as grid_cells
FROM heatmap
GROUP BY fuel_type
ORDER BY hours DESC;

-- 6. Optional: Create annual aggregates (even smaller file for overview maps)
CREATE OR REPLACE TABLE heatmap_annual AS
SELECT
  lat,
  lon,
  ST_Point(lon, lat) AS geometry,
  year,
  fuel_type,
  vessel_type,
  flag,
  SUM(total_hours) AS total_hours,
  SUM(unique_vessels) AS unique_vessels
FROM heatmap
GROUP BY lat, lon, year, fuel_type, vessel_type, flag;

COPY heatmap_annual
TO 'data/heatmap_annual.parquet'
(FORMAT PARQUET, COMPRESSION 'zstd');
