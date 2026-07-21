#!/usr/bin/env bash
# weather.sh - Get weather data using Open-Meteo API
# Usage: weather.sh <command> <location>
# Commands: current, forecast, hourly
# Location: city name or "lat,lon" coordinates

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

API_BASE="https://api.open-meteo.com/v1"
GEO_BASE="https://geocoding-api.open-meteo.com/v1"

usage() {
    echo "Usage: $0 <command> <location>"
    echo ""
    echo "Commands:"
    echo "  current   - Current weather conditions"
    echo "  forecast  - 7-day weather forecast"
    echo "  hourly    - 24-hour hourly forecast"
    echo ""
    echo "Location:"
    echo "  City name: \"Beijing\", \"New York\""
    echo "  Coordinates: 39.9,116.4"
    echo ""
    echo "Examples:"
    echo "  $0 current \"Beijing\""
    echo "  $0 forecast \"Tokyo\""
    echo "  $0 hourly 40.7,-74.0"
    exit 1
}

# WMO weather code to description
weather_code_desc() {
    local code=$1
    case $code in
        0) echo "Clear sky ☀️" ;;
        1) echo "Mainly clear 🌤️" ;;
        2) echo "Partly cloudy ⛅" ;;
        3) echo "Overcast ☁️" ;;
        45|48) echo "Foggy 🌫️" ;;
        51) echo "Light drizzle 🌧️" ;;
        53) echo "Drizzle 🌧️" ;;
        55) echo "Heavy drizzle 🌧️" ;;
        56) echo "Freezing drizzle 🌨️" ;;
        57) echo "Heavy freezing drizzle 🌨️" ;;
        61) echo "Slight rain 🌧️" ;;
        63) echo "Rain 🌧️" ;;
        65) echo "Heavy rain 🌧️" ;;
        66) echo "Freezing rain 🌨️" ;;
        67) echo "Heavy freezing rain 🌨️" ;;
        71) echo "Slight snow ❄️" ;;
        73) echo "Snow ❄️" ;;
        75) echo "Heavy snow ❄️" ;;
        77) echo "Snow grains 🌨️" ;;
        80) echo "Rain showers 🌦️" ;;
        81) echo "Moderate rain showers 🌦️" ;;
        82) echo "Violent rain showers 🌦️" ;;
        85) echo "Snow showers 🌨️" ;;
        86) echo "Heavy snow showers 🌨️" ;;
        95) echo "Thunderstorm ⛈️" ;;
        96) echo "Thunderstorm with hail ⛈️" ;;
        99) echo "Severe thunderstorm ⛈️" ;;
        *) echo "Unknown ($code)" ;;
    esac
}

# Parse coordinates from location input
get_coordinates() {
    local location="$1"

    # Check if already coordinates (lat,lon format)
    if [[ "$location" =~ ^-?[0-9]+\.?[0-9]*,-?[0-9]+\.?[0-9]*$ ]]; then
        echo "$location"
        return
    fi

    # Geocode city name
    local response
    response=$(curl -s "$GEO_BASE/search?name=$location&count=1&language=en&format=json")

    local lat lon name country
    lat=$(echo "$response" | jq -r '.results[0].latitude // empty')
    lon=$(echo "$response" | jq -r '.results[0].longitude // empty')
    name=$(echo "$response" | jq -r '.results[0].name // empty')
    country=$(echo "$response" | jq -r '.results[0].country // empty')

    if [[ -z "$lat" || -z "$lon" ]]; then
        echo -e "${RED}Error: Location '$location' not found${NC}" >&2
        exit 1
    fi

    echo "$lat,$lon"
    echo "LOC_NAME=$name" >&2
    echo "LOC_COUNTRY=$country" >&2
}

# Current weather
cmd_current() {
    local coords="$1"
    local lat="${coords%,*}"
    local lon="${coords#*,}"

    local response
    response=$(curl -s "$API_BASE/forecast?latitude=$lat&longitude=$lon&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m&timezone=auto")

    local temp humidity feels_like is_day precip rain snow code cloud pressure wind wind_gust wind_dir sunrise sunset
    temp=$(echo "$response" | jq -r '.current.temperature_2m')
    humidity=$(echo "$response" | jq -r '.current.relative_humidity_2m')
    feels_like=$(echo "$response" | jq -r '.current.apparent_temperature')
    is_day=$(echo "$response" | jq -r '.current.is_day')
    precip=$(echo "$response" | jq -r '.current.precipitation')
    rain=$(echo "$response" | jq -r '.current.rain')
    snow=$(echo "$response" | jq -r '.current.snowfall')
    code=$(echo "$response" | jq -r '.current.weather_code')
    cloud=$(echo "$response" | jq -r '.current.cloud_cover')
    pressure=$(echo "$response" | jq -r '.current.surface_pressure')
    wind=$(echo "$response" | jq -r '.current.wind_speed_10m')
    wind_gust=$(echo "$response" | jq -r '.current.wind_gusts_10m')
    wind_dir=$(echo "$response" | jq -r '.current.wind_direction_10m')

    local condition
    condition=$(weather_code_desc "$code")

    # Get sunrise/sunset
    local dawn_response
    dawn_response=$(curl -s "$API_BASE/elevation?latitude=$lat&longitude=$lon" | jq -r '.elevation // "N/A"')

    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}🌤️ Current Weather${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  Condition:  ${BLUE}$condition${NC} (code: $code)"
    echo -e "  Temperature: ${YELLOW}${temp}°C${NC}"
    echo -e "  Feels like: ${YELLOW}${feels_like}°C${NC}"
    echo ""
    echo -e "  Humidity:   ${CYAN}${humidity}%${NC}"
    echo -e "  Cloud cover: ${CYAN}${cloud}%${NC}"
    echo -e "  Pressure: ${pressure} hPa"
    echo ""
    echo -e "  Wind speed: ${wind} km/h (gusts: ${wind_gust} km/h)"
    echo -e "  Wind direction: ${wind_dir}°"
    echo ""
    echo -e "  Precipitation: ${precip} mm"
    echo -e "  Rain: ${rain} mm | Snow: ${snow} mm"
    echo ""

    if [[ "$is_day" == "1" ]]; then
        echo -e "  🌞 Daytime"
    else
        echo -e "  🌙 Nighttime"
    fi
    echo ""
}

# 7-day forecast
cmd_forecast() {
    local coords="$1"
    local lat="${coords%,*}"
    local lon="${coords#*,}"

    local response
    response=$(curl -s "$API_BASE/forecast?latitude=$lat&longitude=$lon&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,rain_sum,snowfall_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset&timezone=auto&forecast_days=7")

    local num_days
    num_days=$(echo "$response" | jq '.daily.time | length')

    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}📅 7-Day Weather Forecast${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    printf "  %-10s %-4s %-6s %-6s %-6s %-6s %-8s\n" "Day" "Code" "High" "Low" "Rain" "Snow" "UV"
    echo -e "  ${BLUE}────────────────────────────────────────────────${NC}"

    for ((i=0; i<num_days; i++)); do
        local date code high low precip rain snow uv sunrise sunset
        date=$(echo "$response" | jq -r ".daily.time[$i]")
        code=$(echo "$response" | jq -r ".daily.weather_code[$i]")
        high=$(echo "$response" | jq -r ".daily.temperature_2m_max[$i]")
        low=$(echo "$response" | jq -r ".daily.temperature_2m_min[$i]")
        precip=$(echo "$response" | jq -r ".daily.precipitation_sum[$i]")
        rain=$(echo "$response" | jq -r ".daily.rain_sum[$i]")
        snow=$(echo "$response" | jq -r ".daily.snowfall_sum[$i]")
        uv=$(echo "$response" | jq -r ".daily.uv_index_max[$i]")
        sunrise=$(echo "$response" | jq -r ".daily.sunrise[$i]")
        sunset=$(echo "$response" | jq -r ".daily.sunset[$i]")

        local day_name
        if [[ $i -eq 0 ]]; then
            day_name="Today"
        elif [[ $i -eq 1 ]]; then
            day_name="Tomorrow"
        else
            day_name=$(LC_TIME=en_US.UTF-8 date -d "$date" +"%a" 2>/dev/null || echo "Day $((i+1))")
        fi

        printf "  %-10s %-4s %-6s %-6s %-6s %-6s %-8s\n" "$day_name" "$code" "${high}°" "${low}°" "${rain}mm" "${snow}mm" "$uv"
    done

    echo ""
}

# Hourly forecast (24h)
cmd_hourly() {
    local coords="$1"
    local lat="${coords%,*}"
    local lon="${coords#*,}"

    local response
    response=$(curl -s "$API_BASE/forecast?latitude=$lat&longitude=$lon&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m&timezone=auto&forecast_days=1")

    local current_hour
    current_hour=$(date -u +"%-H")

    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}🕐 24-Hour Forecast${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    printf "  %-6s %-6s %-8s %-10s %-6s %-5s\n" "Time" "Temp" "Feels" "Condition" "Rain" "Wind"
    echo -e "  ${BLUE}────────────────────────────────────────────${NC}"

    local num_hours
    num_hours=$(echo "$response" | jq '.hourly.time | length')

    for ((i=0; i<num_hours; i++)); do
        local time_str temp feels like_code code precip_prob wind
        time_str=$(echo "$response" | jq -r ".hourly.time[$i] | split(\"T\")[1] | split(\":\")[0]")
        temp=$(echo "$response" | jq -r ".hourly.temperature_2m[$i]")
        feels=$(echo "$response" | jq -r ".hourly.apparent_temperature[$i]")
        code=$(echo "$response" | jq -r ".hourly.weather_code[$i]")
        precip_prob=$(echo "$response" | jq -r ".hourly.precipitation_probability[$i]")
        wind=$(echo "$response" | jq -r ".hourly.wind_speed_10m[$i]")

        # Get condition (abbreviated)
        local short_cond
        case $code in
            0) short_cond="☀️" ;;
            1|2) short_cond="⛅" ;;
            3) short_cond="☁️" ;;
            45|48) short_cond="🌫️" ;;
            51|53|55) short_cond="🌧️" ;;
            61|63|65) short_cond="🌧️" ;;
            71|73|75|77) short_cond="❄️" ;;
            80|81|82) short_cond="🌦️" ;;
            95|96|99) short_cond="⛈️" ;;
            *) short_cond="?" ;;
        esac

        printf "  %-6s %-6s %-8s %-10s %-6s %-5s\n" "${time_str}:00" "${temp}°" "${feels}°" "$short_cond" "${precip_prob}%" "${wind}km/h"
    done

    echo ""
}

# Main
if [[ $# -lt 2 ]]; then
    usage
fi

COMMAND="$1"
LOCATION="$2"

# Get coordinates
COORDS=$(get_coordinates "$LOCATION" 2>&1)
if [[ "$COORDS" == *"LOC_NAME="* ]]; then
    LOC_NAME=$(echo "$COORDS" | grep "LOC_NAME=" | cut -d= -f2)
    LOC_COUNTRY=$(echo "$COORDS" | grep "LOC_COUNTRY=" | cut -d= -f2)
    COORDS=$(echo "$COORDS" | head -1)
    echo -e "${CYAN}Location: $LOC_NAME, $LOC_COUNTRY${NC}"
    echo -e "${CYAN}Coordinates: $COORDS${NC}"
    echo ""
fi

case "$COMMAND" in
    current)
        cmd_current "$COORDS"
        ;;
    forecast)
        cmd_forecast "$COORDS"
        ;;
    hourly)
        cmd_hourly "$COORDS"
        ;;
    *)
        echo -e "${RED}Error: Unknown command '$COMMAND'${NC}"
        usage
        ;;
esac
