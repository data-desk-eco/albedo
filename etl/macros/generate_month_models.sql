{% macro generate_vessel_staging_cte(year, month) %}
    select
        '{{ year }}-{{ month }}' as month,
        unnest(
            json_extract(
                content,
                '$.entries[0]."public-global-presence:v3.0"'
            )::JSON[]
        ) as vessel
    from read_text('../data/gfw/{{ year }}-{{ month }}.json')
{% endmacro %}

{% macro flatten_vessel_json() %}
    vessel->>'mmsi' as mmsi,
    vessel->>'imo' as imo,
    vessel->>'shipName' as ship_name,
    vessel->>'callsign' as callsign,
    vessel->>'flag' as flag,
    vessel->>'vesselType' as vessel_type,
    vessel->>'geartype' as gear_type,
    cast(vessel->>'hours' as integer) as hours,
    cast(vessel->>'lat' as double) as lat,
    cast(vessel->>'lon' as double) as lon,
    try_cast(vessel->>'entryTimestamp' as timestamp) as entry_timestamp,
    try_cast(vessel->>'exitTimestamp' as timestamp) as exit_timestamp,
    vessel->>'vesselId' as vessel_id,
    vessel->>'dataset' as dataset,
    try_cast(vessel->>'firstTransmissionDate' as timestamp) as first_transmission_date,
    try_cast(vessel->>'lastTransmissionDate' as timestamp) as last_transmission_date
{% endmacro %}
