import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("Debug tool windows are native singletons owned by the Debug window", async () => {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const userData = mkdtempSync(join(tmpdir(), "agent-k-e2e-"));
  const application = await electron.launch({
    args: ["."],
    cwd: repository,
    env: {
      ...environment,
      AGENT_K_E2E: "1",
      AGENT_K_E2E_DEBUG_ADAPTER: join(repository, "test/fixtures/fake-debug-adapter.mjs"),
      AGENT_K_E2E_SOURCE: join(repository, "test/fixtures/e2e-main.cpp"),
      AGENT_K_E2E_USER_DATA: userData,
    },
  });
  try {
    await application.firstWindow();
    await expect.poll(() => application.windows().length).toBeGreaterThan(1);
    const main = application.windows().find((page) => !page.url().includes("splashscreen"));
    if (!main) throw new Error("The Agent K main window was not created");
    await main.waitForLoadState("domcontentloaded");
    const openedDebug = application.waitForEvent("window", { predicate: (page) => new URL(page.url()).searchParams.get("window") === "debug" });
    await main.evaluate((root) => window.agentK.window.invoke("open-debug", { root }), repository);
    const debug = await openedDebug;
    await debug.waitForLoadState("domcontentloaded");
    await expect(debug.locator(".debug-toolbar")).toHaveCount(0);
    const program = debug.locator('input[placeholder*="程序路径"], input[placeholder*="Program path"]').first();
    await program.fill(join(repository, "package.json"));
    await debug.locator(".debug-start-button").click();
    await main.bringToFront();
    await expect(debug.locator(".debug-state")).toContainText("stopped", { timeout: 20_000 });
    await expect.poll(() => debug.evaluate(() => document.hasFocus())).toBe(true);
    const replayed = await main.evaluate((file) => new Promise<{ state?: string; stoppedFile?: string }>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener("agent-k-debug-state", receive);
        reject(new Error("The current debug state was not replayed"));
      }, 5_000);
      const receive = (event: Event) => {
        const snapshot = (event as CustomEvent<{ selectedFrameId?: number; state?: string; threads?: Array<{ frames?: Array<{ file?: string; id?: number }> }> }>).detail;
        const frame = snapshot.threads?.flatMap((thread) => thread.frames ?? []).find((item) => item.id === snapshot.selectedFrameId);
        window.clearTimeout(timeout);
        window.removeEventListener("agent-k-debug-state", receive);
        resolve({ state: snapshot.state, stoppedFile: frame?.file });
      };
      window.addEventListener("agent-k-debug-state", receive);
      window.dispatchEvent(new CustomEvent("agent-k-debug-state-request", { detail: { file } }));
    }), join(repository, "test/fixtures/e2e-main.cpp"));
    expect(replayed).toEqual({ state: "stopped", stoppedFile: join(repository, "test/fixtures/e2e-main.cpp") });
    const locals = debug.locator(".debug-pane-locals");
    await expect(locals).toContainText("answer");
    await expect(locals).toContainText("0x2000");
    await expect(locals).not.toContainText("General Purpose Registers");
    const nameCell = locals.locator(".debug-variable-row").filter({ hasText: "answer" }).first().locator(":scope > span");
    const initialNameWidth = (await nameCell.boundingBox())?.width ?? 0;
    const columnHandle = locals.locator(".debug-variable-column-resizer").first();
    const handleBox = await columnHandle.boundingBox();
    if (!handleBox) throw new Error("The local-variable column resize handle is unavailable");
    await debug.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await debug.mouse.down();
    await debug.mouse.move(handleBox.x + handleBox.width / 2 + 40, handleBox.y + handleBox.height / 2);
    await debug.mouse.up();
    expect((await nameCell.boundingBox())?.width ?? 0).toBeGreaterThan(initialNameWidth);
    const firstSessionId = await debug.locator(".debug-session-bar select").inputValue();
    const pointerAddress = await debug.evaluate(async (sessionId) => window.agentK.invoke<{ memoryReference?: string }>("language_server_call", {
      args: ["&(pointer)", "watch", sessionId], id: "cpp-clangd", method: "debugEvaluate",
    }), firstSessionId);
    expect(pointerAddress.memoryReference).toBe("0x4000");
    const pointerLocal = locals.locator(".debug-variable-row").filter({ hasText: "pointer" }).first();
    await expect(pointerLocal).toContainText("0x3000");
    await expect(pointerLocal.locator(".debug-variable-address")).toHaveText("0x4000");
    const answer = locals.locator(".debug-variable-row").filter({ hasText: "answer" }).first();
    await answer.click({ button: "right" });
    await debug.locator(".debug-variable-menu button").nth(0).click();
    await expect(answer).toContainText("0x2a");
    await answer.click({ button: "right" });
    await debug.locator(".debug-variable-menu button").nth(2).click();
    await expect(debug.locator(".debug-watch").filter({ hasText: "answer" })).toHaveCount(1);
    const watchInput = debug.locator(".debug-pane-watch form input");
    await watchInput.fill("pointer");
    await watchInput.press("Enter");
    const pointerWatch = debug.locator(".debug-watch").filter({ hasText: "pointer" });
    await expect(pointerWatch.locator(".debug-watch-summary")).toContainText("0x3000");
    await expect(pointerWatch.locator(".debug-watch-summary .debug-watch-delete")).toHaveCount(1);
    await pointerWatch.locator(".debug-watch-summary .debug-variable-toggle").click();
    await expect(pointerWatch.locator(".debug-variable-row")).toContainText("*pointer");
    await watchInput.fill("&answer");
    await watchInput.press("Enter");
    const addressWatch = debug.locator(".debug-watch").filter({ hasText: "&answer" });
    await expect(addressWatch.locator(".debug-watch-summary > code").first()).toHaveText("0x2000");
    await expect(addressWatch.locator(".debug-variable-address")).toHaveText("—");

    await debug.locator('.debug-session-bar button[title*="新建"], .debug-session-bar button[title*="New"]').click();
    await expect(debug.locator(".debug-launch-form")).toBeVisible();
    await debug.locator(".debug-start-button").click();
    await expect(debug.locator(".debug-session-bar select option")).toHaveCount(2, { timeout: 20_000 });
    await expect(debug.locator(".debug-state")).toContainText("stopped", { timeout: 20_000 });
    const sessionIds = await debug.locator(".debug-session-bar select option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(new Set(sessionIds).size).toBe(2);
    const currentSessionId = await debug.locator(".debug-session-bar select").inputValue();
    const selectedSessionId = sessionIds.find((sessionId) => sessionId !== currentSessionId)!;
    await debug.locator(".debug-session-bar select").selectOption(selectedSessionId);
    await expect(debug.locator(".debug-session-bar select")).toHaveValue(selectedSessionId);
    await expect(debug.locator(".debug-state")).toContainText("stopped");

    for (const [icon, kind] of [["fa-memory", "memory"], ["fa-microchip", "registers"], ["fa-code", "disassembly"]] as const) {
      const opened = application.waitForEvent("window", { predicate: (page) => new URL(page.url()).searchParams.get("tool") === kind });
      await debug.locator(`.debug-toolbar .${icon}`).locator("..").click();
      const tool = await opened;
      await tool.waitForLoadState("domcontentloaded");
      expect(new URL(tool.url()).searchParams.get("session-id")).toBe(selectedSessionId);
      const count = application.windows().filter((page) => new URL(page.url()).searchParams.get("tool") === kind).length;
      await debug.locator(`.debug-toolbar .${icon}`).locator("..").click();
      expect(application.windows().filter((page) => new URL(page.url()).searchParams.get("tool") === kind)).toHaveLength(count);
    }

    await debug.locator('.debug-toolbar button[title*="停止进程"], .debug-toolbar button[title*="Stop process"]').click();
    await expect(debug.locator(".debug-session-bar select option")).toHaveCount(1);
    await expect(debug.locator(".debug-state")).toContainText("stopped");
    await debug.locator('.debug-toolbar button[title*="分离进程"], .debug-toolbar button[title*="Detach"]').click();
    await expect(debug.locator(".debug-session-bar")).toHaveCount(0);

    await debug.close();
    await expect.poll(() => application.windows().filter((page) => new URL(page.url()).searchParams.get("window") === "debug-tool").length).toBe(0);
  } finally {
    await application.close();
    rmSync(userData, { force: true, recursive: true });
  }
});
