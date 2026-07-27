---
name: weather
description: Get current weather and forecasts for a city or coordinates through Open-Meteo. Use when asked about current conditions, temperature, hourly weather, a seven-day forecast, or outdoor planning. No API key is required.
---

# Weather Skill

Get weather data using the free Open-Meteo API.

Use the absolute directory supplied for this Skill as `<skill-dir>`; the script
is installed with Agent K and is not located in the user's project. It requires
`bash`, `curl`, `jq`, and outbound HTTPS access.

## Quick Start

```bash
# Current weather for a city
<skill-dir>/scripts/weather.sh current "Beijing"

# 7-day forecast
<skill-dir>/scripts/weather.sh forecast "New York"

# Weather at coordinates
<skill-dir>/scripts/weather.sh current 39.9,116.4

# Hourly forecast (next 24h)
<skill-dir>/scripts/weather.sh hourly "Tokyo"
```

## Commands

| Command | Description |
|---------|-------------|
| `current <city>` | Current weather conditions |
| `forecast <city>` | 7-day weather forecast |
| `hourly <city>` | 24-hour hourly forecast |
| `current <lat>,<lon>` | Weather at coordinates |

## API Details

- **Provider**: Open-Meteo
- **API Key**: Not required
- **Usage policy**: Subject to Open-Meteo's current public API terms and availability
- **Geocoding**: Built-in city search

## Output Format

Current weather includes:
- Temperature (current, high, low)
- Weather condition (WMO code → description)
- Humidity, wind speed, pressure
- Feels like temperature
- Sunrise/sunset times

Forecast output includes:
- Daily high/low temperatures
- Precipitation probability
- Weather conditions

The script reports the first geocoding match for a city string. Include region
or country when the name is ambiguous, and state that weather data is external
and may be delayed rather than presenting it as a safety-critical observation.

## WMO Weather Codes

| Code | Condition |
|------|-----------|
| 0 | Clear sky ☀️ |
| 1-3 | Partly cloudy ⛅ |
| 45-48 | Foggy 🌫️ |
| 51-57 | Drizzle 🌧️ |
| 61-65 | Rain 🌧️ |
| 66-67 | Freezing rain 🌨️ |
| 71-77 | Snow ❄️ |
| 80-82 | Rain showers 🌦️ |
| 85-86 | Snow showers 🌨️ |
| 95-99 | Thunderstorm ⛈️ |
