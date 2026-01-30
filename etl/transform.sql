-- Albedo ETL Pipeline
-- Replaces dbt models with plain SQL
-- Run with: duckdb data/data.duckdb < etl/transform.sql
--
-- Creates tables:
--   - vessel_positions: All position data (25M+ rows)
--   - vessel_activity: Aggregated vessel stats (80K+ vessels)
--   - protected_areas_ocean: Coastal protected areas (filtered, not clipped)
--   - buffer_zones_coastal: Coastal buffer zones
--   - vessel_crossings: Vessels crossing protected areas

INSTALL spatial;
LOAD spatial;

-- =============================================================================
-- STAGING: Load and flatten vessel presence data from Parquet
-- =============================================================================

CREATE OR REPLACE TABLE vessel_presence AS
SELECT
    year,
    vessel->>'mmsi' as mmsi,
    vessel->>'imo' as imo,
    vessel->>'shipName' as ship_name,
    vessel->>'callsign' as callsign,
    vessel->>'flag' as flag,
    vessel->>'vesselType' as vessel_type,
    vessel->>'geartype' as gear_type,
    CAST(vessel->>'hours' AS DOUBLE) as hours,
    CAST(vessel->>'lat' AS DOUBLE) as lat,
    CAST(vessel->>'lon' AS DOUBLE) as lon,
    TRY_CAST(vessel->>'entryTimestamp' AS TIMESTAMP) as entry_timestamp,
    TRY_CAST(vessel->>'exitTimestamp' AS TIMESTAMP) as exit_timestamp,
    vessel->>'vesselId' as vessel_id,
    vessel->>'dataset' as dataset,
    TRY_CAST(vessel->>'firstTransmissionDate' AS TIMESTAMP) as first_transmission_date,
    TRY_CAST(vessel->>'lastTransmissionDate' AS TIMESTAMP) as last_transmission_date
FROM read_parquet('data/gfw/*/*.parquet');

-- =============================================================================
-- INTERMEDIATE: Clean and snap to grid
-- =============================================================================

CREATE OR REPLACE TABLE vessel_positions AS
SELECT
    vessel_id,
    mmsi,
    ship_name,
    flag,
    vessel_type,
    gear_type,
    ROUND(lat, 2) as lat,
    ROUND(lon, 2) as lon,
    hours,
    entry_timestamp,
    exit_timestamp,
    year,
    CONCAT(vessel_id, '_', year, '_', ROUND(lat, 2), '_', ROUND(lon, 2)) as activity_key
FROM vessel_presence
WHERE mmsi IS NOT NULL
  AND lat IS NOT NULL
  AND lon IS NOT NULL
  AND hours > 0;

-- =============================================================================
-- VESSEL ACTIVITY (aggregated stats per vessel)
-- =============================================================================

CREATE OR REPLACE TABLE vessel_activity AS
SELECT
    vessel_id,
    mmsi,
    ship_name,
    flag,
    vessel_type,
    gear_type,
    COUNT(*) as total_detections,
    SUM(hours) as total_hours,
    MIN(entry_timestamp) as first_seen,
    MAX(exit_timestamp) as last_seen,
    AVG(lat) as avg_lat,
    AVG(lon) as avg_lon,
    MIN(lat) as min_lat,
    MAX(lat) as max_lat,
    MIN(lon) as min_lon,
    MAX(lon) as max_lon,
    LIST(DISTINCT year ORDER BY year) as years_active
FROM vessel_positions
GROUP BY vessel_id, mmsi, ship_name, flag, vessel_type, gear_type;

-- =============================================================================
-- SHARED: Ocean mask for coastal filtering
-- =============================================================================

CREATE OR REPLACE TABLE ocean_mask AS
WITH study_area AS (
    SELECT ST_GeomFromText('POLYGON((-180 50, 180 50, 180 90, -180 90, -180 50))') as geometry
),
land_raw AS (
    SELECT * FROM ST_Read('data/ne_10m_land/ne_10m_land.shp')
),
land_geom AS (
    SELECT ST_GeomFromWKB(ST_AsWKB(geom)) as geometry
    FROM land_raw
    WHERE ST_Intersects(
        ST_GeomFromWKB(ST_AsWKB(geom)),
        (SELECT geometry FROM study_area)
    )
),
land_union AS (
    SELECT ST_Union_Agg(geometry) as geometry
    FROM land_geom
)
SELECT ST_Difference(
    (SELECT geometry FROM study_area),
    (SELECT geometry FROM land_union)
) as geometry;

-- =============================================================================
-- PROTECTED AREAS (coastal only, full polygons — not clipped to ocean)
-- =============================================================================

CREATE OR REPLACE TABLE protected_areas_ocean AS
WITH protected_areas_raw AS (
    SELECT unnest(features) as feature
    FROM read_json_auto('data/protected_areas.geojson', maximum_object_size=200000000)
),
protected_areas_geom AS (
    SELECT
        feature.id as feature_id,
        feature.properties.title as area_name,
        feature.properties.category_title as category,
        feature.properties.sig as significance,
        feature.properties.area as area_ha,
        feature.properties.status_title as status,
        ST_GeomFromGeoJSON(json(feature.geometry)) as geometry
    FROM protected_areas_raw
)
SELECT
    pa.feature_id,
    pa.area_name,
    pa.category,
    pa.significance,
    pa.area_ha,
    pa.status,
    pa.geometry
FROM protected_areas_geom pa
CROSS JOIN ocean_mask o
WHERE ST_Intersects(pa.geometry, o.geometry)
  -- Exclude Большой Арктический (Great Arctic) - boundary too complex
  AND pa.feature_id != 'oopt_wth_details.fid-e747cd5_19a6f70ccf9_-2215';

-- =============================================================================
-- BUFFER ZONES (coastal only)
-- =============================================================================

CREATE OR REPLACE TABLE buffer_zones_coastal AS
WITH buffer_zones_raw AS (
    SELECT unnest(features) as feature
    FROM read_json_auto('data/buffer_zones/raw.geojson', maximum_object_size=200000000)
),
buffer_zones_geom AS (
    SELECT
        feature.properties.name as area_name,
        feature.properties.category as category,
        feature.properties.area_ha as area_ha,
        ST_GeomFromGeoJSON(json(feature.geometry)) as geometry
    FROM buffer_zones_raw
)
SELECT
    bz.area_name,
    bz.category,
    bz.area_ha,
    bz.geometry
FROM buffer_zones_geom bz
CROSS JOIN ocean_mask o
WHERE ST_Intersects(bz.geometry, o.geometry);

-- =============================================================================
-- Cleanup staging table (optional - keep for debugging)
-- =============================================================================
-- DROP TABLE IF EXISTS vessel_presence;

-- Report results
SELECT 'vessel_positions' as table_name, COUNT(*) as row_count FROM vessel_positions
UNION ALL
SELECT 'vessel_activity', COUNT(*) FROM vessel_activity
UNION ALL
SELECT 'protected_areas_ocean', COUNT(*) FROM protected_areas_ocean
UNION ALL
SELECT 'buffer_zones_coastal', COUNT(*) FROM buffer_zones_coastal;
