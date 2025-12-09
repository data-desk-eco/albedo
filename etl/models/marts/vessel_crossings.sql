-- Vessel crossings into protected areas
-- Identifies vessels spending 1+ hours within protected area boundaries
-- Calculates centroid of activity for visualization
-- Uses ocean-only protected areas (excludes rivers/inland)

{{ config(materialized='table') }}

WITH crossings_raw AS (
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

crossings_aggregated AS (
    SELECT
        cr.feature_id,
        cr.area_name,
        cr.vessel_id,
        cr.mmsi,
        cr.ship_name,
        cr.flag,
        cr.vessel_type,
        cr.gear_type,
        sum(cr.hours) as total_hours,
        min(cr.entry_timestamp) as first_seen,
        max(cr.exit_timestamp) as last_seen,
        -- Centroid of activity (weighted by hours)
        sum(cr.lon * cr.hours) / sum(cr.hours) as raw_centroid_lon,
        sum(cr.lat * cr.hours) / sum(cr.hours) as raw_centroid_lat,
        count(*) as position_count,
        pa.geometry as pa_geometry
    FROM crossings_raw cr
    JOIN {{ ref('protected_areas_ocean') }} pa ON cr.feature_id = pa.feature_id
    GROUP BY
        cr.feature_id,
        cr.area_name,
        cr.vessel_id,
        cr.mmsi,
        cr.ship_name,
        cr.flag,
        cr.vessel_type,
        cr.gear_type,
        pa.geometry
    HAVING sum(cr.hours) >= 1  -- Minimum 1 hour threshold
),

-- Ensure centroids fall within the ocean portion of protected areas
crossings_snapped AS (
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
        position_count,
        -- If centroid is outside the ocean geometry, use nearest point on geometry
        CASE
            WHEN ST_Within(ST_Point(raw_centroid_lon, raw_centroid_lat), pa_geometry)
            THEN raw_centroid_lon
            ELSE ST_X(ST_PointOnSurface(pa_geometry))
        END as centroid_lon,
        CASE
            WHEN ST_Within(ST_Point(raw_centroid_lon, raw_centroid_lat), pa_geometry)
            THEN raw_centroid_lat
            ELSE ST_Y(ST_PointOnSurface(pa_geometry))
        END as centroid_lat
    FROM crossings_aggregated
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
    EXTRACT(YEAR FROM first_seen)::INTEGER as year,
    centroid_lon,
    centroid_lat,
    position_count,
    -- Create point geometry for export
    ST_AsGeoJSON(ST_Point(centroid_lon, centroid_lat)) as geometry
FROM crossings_snapped
ORDER BY total_hours DESC
