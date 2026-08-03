import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = () => readFile(
  new URL("../src/features/settings/SettingsDialog.tsx", import.meta.url),
  "utf8",
);

test("provider settings reload the runtime before reading the provider catalog", async () => {
  const settings = await source();
  assert.match(
    settings,
    /page !== "models"[\s\S]*?setTimeout\(\(\) => void refresh\(true\), 0\)/,
  );
  assert.match(
    settings,
    /const reloadModelConfiguration = async \(\) => \{\s*await desktop\.reloadPiRuntimes\(\);[\s\S]*?await refresh\(true\);/,
  );
});

test("external Pi login is detected and activates the refreshed runtime", async () => {
  const settings = await source();
  assert.match(settings, /setPendingProviderLogin\(provider\.id\)/);
  assert.match(
    settings,
    /pendingProviderLogin[\s\S]*?desktop\.providerCatalog\(\)[\s\S]*?provider\?\.configured/,
  );
  assert.match(
    settings,
    /provider\?\.configured[\s\S]*?desktop\.reloadPiRuntimes\(\)/,
  );
});
