#!/usr/bin/env node

const API_BASE =
  process.env.OPEN_METEO_API_BASE?.replace(/\/$/, "") ??
  "https://api.open-meteo.com/v1";
const GEO_BASE =
  process.env.OPEN_METEO_GEO_BASE?.replace(/\/$/, "") ??
  "https://geocoding-api.open-meteo.com/v1";

const colorEnabled = !process.env.NO_COLOR;
const colors = {
  red: colorEnabled ? "\u001b[31m" : "",
  green: colorEnabled ? "\u001b[32m" : "",
  yellow: colorEnabled ? "\u001b[33m" : "",
  blue: colorEnabled ? "\u001b[34m" : "",
  cyan: colorEnabled ? "\u001b[36m" : "",
  reset: colorEnabled ? "\u001b[0m" : "",
};

function usage() {
  console.error(`Usage: weather.sh <command> <location>

Commands:
  current   Current weather conditions
  forecast  7-day weather forecast
  hourly    24-hour hourly forecast

Location:
  City name: "Beijing", "New York"
  Coordinates: 39.9,116.4`);
}

function weatherDescription(code) {
  const descriptions = new Map([
    [0, "Clear sky ☀️"],
    [1, "Mainly clear 🌤️"],
    [2, "Partly cloudy ⛅"],
    [3, "Overcast ☁️"],
    [45, "Foggy 🌫️"],
    [48, "Foggy 🌫️"],
    [51, "Light drizzle 🌧️"],
    [53, "Drizzle 🌧️"],
    [55, "Heavy drizzle 🌧️"],
    [56, "Freezing drizzle 🌨️"],
    [57, "Heavy freezing drizzle 🌨️"],
    [61, "Slight rain 🌧️"],
    [63, "Rain 🌧️"],
    [65, "Heavy rain 🌧️"],
    [66, "Freezing rain 🌨️"],
    [67, "Heavy freezing rain 🌨️"],
    [71, "Slight snow ❄️"],
    [73, "Snow ❄️"],
    [75, "Heavy snow ❄️"],
    [77, "Snow grains 🌨️"],
    [80, "Rain showers 🌦️"],
    [81, "Moderate rain showers 🌦️"],
    [82, "Violent rain showers 🌦️"],
    [85, "Snow showers 🌨️"],
    [86, "Heavy snow showers 🌨️"],
    [95, "Thunderstorm ⛈️"],
    [96, "Thunderstorm with hail ⛈️"],
    [99, "Severe thunderstorm ⛈️"],
  ]);
  return descriptions.get(Number(code)) ?? `Unknown (${code})`;
}

function weatherIcon(code) {
  const value = Number(code);
  if (value === 0) return "☀️";
  if (value === 1 || value === 2) return "⛅";
  if (value === 3) return "☁️";
  if (value === 45 || value === 48) return "🌫️";
  if ((value >= 51 && value <= 67)) return "🌧️";
  if ((value >= 71 && value <= 77) || value === 85 || value === 86)
    return "❄️";
  if (value >= 80 && value <= 82) return "🌦️";
  if (value >= 95 && value <= 99) return "⛈️";
  return "?";
}

function display(value, suffix = "") {
  return value === undefined || value === null ? "N/A" : `${value}${suffix}`;
}

async function fetchJson(base, path, parameters) {
  const url = new URL(`${base}${path}`);
  for (const [name, value] of Object.entries(parameters))
    url.searchParams.set(name, String(value));
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (cause) {
    throw new Error(
      `Unable to contact Open-Meteo: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (!response.ok)
    throw new Error(`Open-Meteo returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("Open-Meteo returned invalid JSON");
  }
}

async function resolveLocation(location) {
  const coordinateMatch =
    /^\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*$/.exec(
      location,
    );
  if (coordinateMatch) {
    const latitude = Number(coordinateMatch[1]);
    const longitude = Number(coordinateMatch[2]);
    if (
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    )
      throw new Error(`Coordinates are out of range: ${location}`);
    return { latitude, longitude };
  }

  const data = await fetchJson(GEO_BASE, "/search", {
    name: location,
    count: 1,
    language: "en",
    format: "json",
  });
  const result = data?.results?.[0];
  if (
    !result ||
    typeof result.latitude !== "number" ||
    typeof result.longitude !== "number"
  )
    throw new Error(`Location '${location}' not found`);
  return {
    latitude: result.latitude,
    longitude: result.longitude,
    name: result.name,
    country: result.country,
  };
}

function printLocation(location) {
  if (!location.name) return;
  console.log(
    `${colors.cyan}Location: ${location.name}${
      location.country ? `, ${location.country}` : ""
    }${colors.reset}`,
  );
  console.log(
    `${colors.cyan}Coordinates: ${location.latitude},${location.longitude}${colors.reset}\n`,
  );
}

async function current(location) {
  const data = await fetchJson(API_BASE, "/forecast", {
    latitude: location.latitude,
    longitude: location.longitude,
    current:
      "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    daily: "temperature_2m_max,temperature_2m_min,sunrise,sunset",
    timezone: "auto",
    forecast_days: 1,
  });
  if (!data?.current) throw new Error("Current weather data is unavailable");
  const value = data.current;
  const daily = data.daily ?? {};
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.green}🌤️ Current Weather${colors.reset}`);
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
  console.log(
    `  Condition:   ${colors.blue}${weatherDescription(value.weather_code)}${colors.reset} (code: ${display(value.weather_code)})`,
  );
  console.log(
    `  Temperature: ${colors.yellow}${display(value.temperature_2m, "°C")}${colors.reset}`,
  );
  console.log(
    `  Feels like:  ${colors.yellow}${display(value.apparent_temperature, "°C")}${colors.reset}`,
  );
  console.log(
    `  High / low:  ${display(daily.temperature_2m_max?.[0], "°C")} / ${display(daily.temperature_2m_min?.[0], "°C")}\n`,
  );
  console.log(`  Humidity:    ${colors.cyan}${display(value.relative_humidity_2m, "%")}${colors.reset}`);
  console.log(`  Cloud cover: ${colors.cyan}${display(value.cloud_cover, "%")}${colors.reset}`);
  console.log(`  Pressure:    ${display(value.surface_pressure, " hPa")}\n`);
  console.log(
    `  Wind speed:  ${display(value.wind_speed_10m, " km/h")} (gusts: ${display(value.wind_gusts_10m, " km/h")})`,
  );
  console.log(`  Direction:   ${display(value.wind_direction_10m, "°")}\n`);
  console.log(`  Precipitation: ${display(value.precipitation, " mm")}`);
  console.log(
    `  Rain: ${display(value.rain, " mm")} | Snow: ${display(value.snowfall, " mm")}`,
  );
  console.log(
    `  Sunrise: ${display(daily.sunrise?.[0])} | Sunset: ${display(daily.sunset?.[0])}\n`,
  );
  console.log(value.is_day === 1 ? "  🌞 Daytime\n" : "  🌙 Nighttime\n");
}

function dayName(date, index) {
  if (index === 0) return "Today";
  if (index === 1) return "Tomorrow";
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.valueOf())
    ? `Day ${index + 1}`
    : new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        timeZone: "UTC",
      }).format(parsed);
}

async function forecast(location) {
  const data = await fetchJson(API_BASE, "/forecast", {
    latitude: location.latitude,
    longitude: location.longitude,
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,rain_sum,snowfall_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset",
    timezone: "auto",
    forecast_days: 7,
  });
  const daily = data?.daily;
  if (!Array.isArray(daily?.time))
    throw new Error("Daily forecast data is unavailable");
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.green}📅 7-Day Weather Forecast${colors.reset}`);
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
  console.log("  Day        Code High   Low    Rain   Snow   UV");
  console.log(`  ${colors.blue}────────────────────────────────────────────────${colors.reset}`);
  daily.time.forEach((date, index) => {
    const cells = [
      dayName(date, index).padEnd(10),
      display(daily.weather_code?.[index]).padEnd(4),
      display(daily.temperature_2m_max?.[index], "°").padEnd(6),
      display(daily.temperature_2m_min?.[index], "°").padEnd(6),
      display(daily.rain_sum?.[index], "mm").padEnd(6),
      display(daily.snowfall_sum?.[index], "mm").padEnd(6),
      display(daily.uv_index_max?.[index]).padEnd(8),
    ];
    console.log(`  ${cells.join(" ")}`);
  });
  console.log();
}

async function hourly(location) {
  const data = await fetchJson(API_BASE, "/forecast", {
    latitude: location.latitude,
    longitude: location.longitude,
    hourly:
      "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m",
    timezone: "auto",
    forecast_days: 1,
  });
  const hourlyData = data?.hourly;
  if (!Array.isArray(hourlyData?.time))
    throw new Error("Hourly forecast data is unavailable");
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.green}🕐 24-Hour Forecast${colors.reset}`);
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
  console.log("  Time   Temp   Feels    Condition  Rain   Wind");
  console.log(`  ${colors.blue}────────────────────────────────────────────${colors.reset}`);
  hourlyData.time.slice(0, 24).forEach((time, index) => {
    const hour = String(time).split("T")[1]?.slice(0, 5) ?? String(time);
    const cells = [
      hour.padEnd(6),
      display(hourlyData.temperature_2m?.[index], "°").padEnd(6),
      display(hourlyData.apparent_temperature?.[index], "°").padEnd(8),
      weatherIcon(hourlyData.weather_code?.[index]).padEnd(10),
      display(hourlyData.precipitation_probability?.[index], "%").padEnd(6),
      display(hourlyData.wind_speed_10m?.[index], "km/h"),
    ];
    console.log(`  ${cells.join(" ")}`);
  });
  console.log();
}

async function main() {
  const [command, ...locationParts] = process.argv.slice(2);
  const locationText = locationParts.join(" ").trim();
  if (!["current", "forecast", "hourly"].includes(command) || !locationText) {
    usage();
    process.exitCode = 1;
    return;
  }
  const location = await resolveLocation(locationText);
  printLocation(location);
  if (command === "current") await current(location);
  else if (command === "forecast") await forecast(location);
  else await hourly(location);
}

main().catch((cause) => {
  console.error(
    `${colors.red}Error: ${
      cause instanceof Error ? cause.message : String(cause)
    }${colors.reset}`,
  );
  process.exitCode = 1;
});
