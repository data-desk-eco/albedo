with vessel_data as (
    select * from {{ ref('vessel_presence') }}
)

select
    month,
    mmsi,
    imo,
    ship_name,
    callsign,
    flag,
    vessel_type,
    gear_type,
    hours,
    -- Snap coordinates to 0.01° grid (removes GFW API floating-point errors)
    round(lat, 2) as lat,
    round(lon, 2) as lon,
    entry_timestamp,
    exit_timestamp,
    vessel_id,
    dataset,
    first_transmission_date,
    last_transmission_date,
    -- Create a unique activity key for deduplication using rounded coords
    concat(vessel_id, '_', month, '_', round(lat, 2), '_', round(lon, 2)) as activity_key

from vessel_data
where
    -- Basic data quality filters
    mmsi is not null
    and lat is not null
    and lon is not null
    and hours > 0
