with vessel_data as (
    select * from {{ ref('vessel_presence_filtered') }}
)

select
    vessel_id,
    mmsi,
    imo,
    ship_name,
    flag,
    vessel_type,
    gear_type,

    -- Aggregate metrics
    count(*) as total_detections,
    sum(hours) as total_hours,
    min(entry_timestamp) as first_seen,
    max(exit_timestamp) as last_seen,

    -- Geographic summary
    avg(lat) as avg_lat,
    avg(lon) as avg_lon,
    min(lat) as min_lat,
    max(lat) as max_lat,
    min(lon) as min_lon,
    max(lon) as max_lon,

    -- Monthly presence
    array_agg(distinct month order by month) as months_active

from vessel_data
group by
    vessel_id,
    mmsi,
    imo,
    ship_name,
    flag,
    vessel_type,
    gear_type
