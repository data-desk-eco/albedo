-- Detailed position data for map visualization
-- This gives you individual points to render on the map

select
    vessel_id,
    mmsi,
    ship_name,
    flag,
    vessel_type,
    gear_type,
    lat,
    lon,
    hours,
    entry_timestamp,
    exit_timestamp,
    month,
    activity_key

from {{ ref('vessel_presence_filtered') }}
