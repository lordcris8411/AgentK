import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const marker = "node --test ";
const command = manifest.scripts?.test;
const offset = typeof command === "string" ? command.indexOf(marker) : -1;
if (offset < 0) throw new Error("package.json test script does not contain a Node test list");
const excluded = new Set((process.env.AGENT_K_TEST_EXCLUDE ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const files = command.slice(offset + marker.length).trim().split(/\s+/u).filter((file) => !excluded.has(file));
const child = spawn(process.execPath, ["--test", ...files], { env: process.env, stdio: "inherit", windowsHide: true });
child.once("error", (cause) => { throw cause; });
child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
