import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "weather.mjs");

function runWeather(args, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        NO_COLOR: "1",
        OPEN_METEO_API_BASE: `http://127.0.0.1:${port}/weather`,
        OPEN_METEO_GEO_BASE: `http://127.0.0.1:${port}/geo`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr, stdout }));
  });
}

test("weather script parses Open-Meteo JSON without jq", async () => {
  let geocodingRequests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/geo/search") {
      geocodingRequests += 1;
      response.end(
        JSON.stringify({
          results: [
            {
              country: "China",
              latitude: 39.9042,
              longitude: 116.4074,
              name: "Beijing",
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname === "/weather/forecast") {
      response.end(
        JSON.stringify({
          current: {
            apparent_temperature: 24,
            cloud_cover: 10,
            is_day: 1,
            precipitation: 0,
            rain: 0,
            relative_humidity_2m: 45,
            snowfall: 0,
            surface_pressure: 1008,
            temperature_2m: 25,
            weather_code: 1,
            wind_direction_10m: 180,
            wind_gusts_10m: 12,
            wind_speed_10m: 6,
          },
          daily: {
            sunrise: ["2026-07-31T05:10"],
            sunset: ["2026-07-31T19:30"],
            temperature_2m_max: [29],
            temperature_2m_min: [20],
          },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        reject(new Error("Server has no TCP port"));
      else resolve(address.port);
    });
  });
  try {
    const result = await runWeather(["current", "Beijing"], port);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Location: Beijing, China/);
    assert.match(result.stdout, /Temperature: 25°C/);
    assert.match(result.stdout, /High \/ low:\s+29°C \/ 20°C/);
    assert.equal(geocodingRequests, 1);

    const coordinates = await runWeather(["current", "39.9,116.4"], port);
    assert.equal(coordinates.code, 0, coordinates.stderr);
    assert.equal(geocodingRequests, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
