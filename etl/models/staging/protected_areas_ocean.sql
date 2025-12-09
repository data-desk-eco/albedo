-- Ocean-only protected areas (excludes rivers and inland areas)
-- Filters protected areas that intersect with ocean mask

{{ config(materialized='table') }}

WITH study_area AS (
    SELECT ST_GeomFromText('POLYGON((-180 50, 180 50, 180 90, -180 90, -180 50))') as geometry
),

land_raw AS (
    SELECT * FROM ST_Read('../data/ne_10m_land/ne_10m_land.shp')
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
),

ocean_mask AS (
    SELECT ST_Difference(
        (SELECT geometry FROM study_area),
        (SELECT geometry FROM land_union)
    ) as geometry
),

protected_areas_raw AS (
    SELECT unnest(features) as feature
    FROM read_json_auto('../data/protected_areas.geojson', maximum_object_size=200000000)
),

protected_areas_geom AS (
    SELECT
        feature.id as feature_id,
        feature.properties.title as area_name,
        ST_GeomFromGeoJSON(json(feature.geometry)) as geometry
    FROM protected_areas_raw
)

-- Clip protected areas to ocean only (removes land portions)
SELECT
    pa.feature_id,
    pa.area_name,
    ST_Intersection(pa.geometry, o.geometry) as geometry
FROM protected_areas_geom pa
CROSS JOIN ocean_mask o
WHERE ST_Intersects(pa.geometry, o.geometry)
