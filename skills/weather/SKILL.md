---
name: weather
description: Get current weather and forecasts for any location worldwide. Uses Open-Meteo API (free, no API key required). Supports current conditions, hourly/daily forecasts, historical data. Use when asked about weather, temperature, or planning outdoor activities.
---

# Weather Skill

Get weather data using the free Open-Meteo API.

## Quick Start

```bash
# Current weather for a city
./scripts/weather.sh current "Beijing"

# 7-day forecast
./scripts/weather.sh forecast "New York"

# Weather at coordinates
./scripts/weather.sh current 39.9,116.4

# Hourly forecast (next 24h)
./scripts/weather.sh hourly "Tokyo"
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
- **Rate Limit**: None
- **Geocoding**: Built-in city search

## Output Format

Current weather includes:
- Temperature (current, high, low)
- Weather condition (WMO code → description)
- Humidity, wind speed, pressure
- Feels like temperature
- Sunrise/sunset times

Forecast includes:
- Daily high/low temperatures
- Precipitation probability
- Weather conditions

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
