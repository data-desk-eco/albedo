-- Vessel incursions into protected areas
-- Identifies vessels spending 1+ hours within protected area boundaries
-- Calculates centroid of activity for visualization
-- Uses ocean-only protected areas (excludes rivers/inland)

{{ config(materialized='table') }}

WITH incursions_raw AS (
    SELECT
        pa.feature_id,
        pa.area_name,
        vp.vessel_id,
        vp.mmsi,
        vp.ship_name,
        vp.flag,
        vp.vessel_type,
        vp.gear_type,
        vp.lat,
        vp.lon,
        vp.hours,
        vp.entry_timestamp,
        vp.exit_timestamp
    FROM {{ ref('vessel_positions') }} vp
    CROSS JOIN {{ ref('protected_areas_ocean') }} pa
    WHERE ST_Within(
        ST_Point(vp.lon, vp.lat),
        pa.geometry
    )
),

incursions_aggregated AS (
    SELECT
        feature_id,
        area_name,
        vessel_id,
        mmsi,
        ship_name,
        flag,
        vessel_type,
        gear_type,
        sum(hours) as total_hours,
        min(entry_timestamp) as first_seen,
        max(exit_timestamp) as last_seen,
        -- Centroid of activity (weighted by hours)
        sum(lon * hours) / sum(hours) as centroid_lon,
        sum(lat * hours) / sum(hours) as centroid_lat,
        count(*) as position_count
    FROM incursions_raw
    GROUP BY
        feature_id,
        area_name,
        vessel_id,
        mmsi,
        ship_name,
        flag,
        vessel_type,
        gear_type
    HAVING sum(hours) >= 1  -- Minimum 1 hour threshold
)

SELECT
    feature_id,
    area_name,
    vessel_id,
    mmsi,
    ship_name,
    flag,
    vessel_type,
    gear_type,
    total_hours,
    first_seen,
    last_seen,
    centroid_lon,
    centroid_lat,
    position_count,
    -- Create point geometry for export
    ST_AsGeoJSON(ST_Point(centroid_lon, centroid_lat)) as geometry
FROM incursions_aggregated
ORDER BY total_hours DESC
