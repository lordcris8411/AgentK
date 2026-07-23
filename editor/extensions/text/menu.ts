import { defineContextMenu, type ContextMenuItem } from "../../sdk";

defineContextMenu(({ directoryEntries, isDirectory, packageJson, viteConfig }) => {
  if (!isDirectory) return [];
  const items: ContextMenuItem[] = [];
  if (packageJson) {
    try {
      const manifest = JSON.parse(packageJson) as {
        scripts?: Record<string, unknown>;
      };
      // A dev script is the reliable contract: it covers Vue/React as well as
      // Vite projects such as Three.js that cannot be opened as raw HTML.
      if (typeof manifest.scripts?.dev === "string" || viteConfig)
        items.push({ id: "run-web-project", label: "运行 Web 项目" });
    } catch {
      // An invalid package manifest does not hide unrelated directory actions.
    }
  }
  if (directoryEntries.includes("CMakeLists.txt"))
    items.push({ id: "compile-cmake-project", label: "编译项目" });
  return items;
});
