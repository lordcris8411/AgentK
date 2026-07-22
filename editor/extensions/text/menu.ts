import { defineContextMenu } from "../../sdk";

defineContextMenu(({ isDirectory, packageJson, viteConfig }) => {
  if (!isDirectory || !packageJson) return [];
  try {
    const manifest = JSON.parse(packageJson) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      scripts?: Record<string, unknown>;
    };
    // A dev script is the reliable contract: it covers Vue/React as well as
    // Vite projects such as Three.js that cannot be opened as raw HTML.
    return (typeof manifest.scripts?.dev === "string" || viteConfig)
      ? [{ id: "run-web-project", label: "运行 Web 项目" }]
      : [];
  } catch {
    return [];
  }
});
