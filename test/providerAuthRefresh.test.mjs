import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = () => readFile(
  new URL("../src/features/settings/SettingsDialog.tsx", import.meta.url),
  "utf8",
);

const conversationSource = () => readFile(
  new URL("../src/features/conversation/ConversationWorkspace.tsx", import.meta.url),
  "utf8",
);

const desktopSettingsSource = () => readFile(
  new URL("../electron/settings.ts", import.meta.url),
  "utf8",
);

const backendSource = () => readFile(
  new URL("../electron/backend.ts", import.meta.url),
  "utf8",
);

const appSource = () => readFile(
  new URL("../src/App.tsx", import.meta.url),
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

test("model catalog changes refresh settings and conversation selectors", async () => {
  const [settings, conversation, backend, app] = await Promise.all([
    source(),
    conversationSource(),
    backendSource(),
    appSource(),
  ]);
  assert.match(backend, /case "reload_pi_runtimes":[\s\S]*?model_catalog_changed/u);
  assert.match(app, /model_catalog_changed" \|\| event\.type === "local_models_changed"[\s\S]*?agent-k-model-catalog-changed/u);
  assert.match(settings, /addEventListener\("agent-k-model-catalog-changed", changed\)[\s\S]*?addEventListener\("agent-k-model-changed", changed\)/u);
  assert.match(conversation, /addEventListener\("agent-k-model-changed", refreshModelName\)[\s\S]*?addEventListener\("agent-k-model-catalog-changed", refreshModelName\)/u);
  assert.match(conversation, /if \(!current\) window\.dispatchEvent\(new Event\("agent-k-model-catalog-changed"\)\)/u);
});

test("late model catalog responses cannot overwrite a newer refresh", async () => {
  const [settings, conversation] = await Promise.all([source(), conversationSource()]);
  assert.match(settings, /generation = \+\+catalogRefreshGenerationRef\.current[\s\S]*?generation !== catalogRefreshGenerationRef\.current/u);
  assert.match(conversation, /generation = \+\+modelRefreshGenerationRef\.current[\s\S]*?generation === modelRefreshGenerationRef\.current/u);
});

test("Codex quota authentication failures stay out of the IPC error channel", async () => {
  const [conversation, settings] = await Promise.all([
    conversationSource(),
    desktopSettingsSource(),
  ]);
  assert.match(
    settings,
    /response\.status === 401 \|\| response\.status === 403[\s\S]*?OpenAI Codex session expired[\s\S]*?retryable: false/,
  );
  assert.match(
    conversation,
    /else if \(result\.retryable\) scheduleRetry\(\)/,
  );
  assert.match(conversation, /if \(refreshPending\) return/);
});
