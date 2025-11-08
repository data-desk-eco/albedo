{{
    config(
        materialized='view'
    )
}}

with vessel_data as (
    select * from {{ ref('vessel_presence') }}
)

select
    *,
    -- Create a unique activity key for deduplication
    concat(vessel_id, '_', month, '_', lat, '_', lon) as activity_key

from vessel_data
where
    -- Basic data quality filters
    mmsi is not null
    and lat is not null
    and lon is not null
    and hours > 0
