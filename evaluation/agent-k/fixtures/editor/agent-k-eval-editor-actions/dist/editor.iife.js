(() => {
  const channel = "agent-k-editor";
  let nonce = "";
  let area;
  const post = (type, value, requestId) => parent.postMessage({ apiVersion: 1, channel, nonce, requestId, type, value }, "*");
  const action = (id, content) => {
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    if (["sort-colors", "sort-events", "sort-keys", "sort-snippets"].includes(id)) return lines.sort((a, b) => a.localeCompare(b)).join("\n");
    if (id === "complete-item") return content.replace(/^\[ \]/mu, "[x]");
    if (id === "promote-heading") return content.replace(/^## /mu, "# ");
    if (id === "deduplicate") return [...new Set(lines)].join("\n");
    if (id === "recount") return `${content.replace(/\n?count=\d+$/u, "")}\ncount=${lines.filter(Boolean).length}`;
    if (id === "reverse-route") return content.split("->").map((item) => item.trim()).reverse().join(" -> ");
    if (id === "normalize-scores") return content.replace(/-?\d+/gu, (value) => String(Math.max(0, Math.min(100, Number(value)))));
    return content;
  };
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.channel !== channel || event.data?.apiVersion !== 1) return;
    const message = event.data;
    if (message.type === "initialize") {
      nonce = message.nonce;
      area = document.createElement("textarea"); area.value = message.value.content; document.body.replaceChildren(area);
      area.addEventListener("input", () => { post("content-change", area.value); post("dirty", true); });
      area.addEventListener("keydown", (keyEvent) => {
        if (!(keyEvent.ctrlKey || keyEvent.metaKey) || keyEvent.key.toLowerCase() !== "s") return;
        keyEvent.preventDefault(); post("request-save", area.value);
      });
      document.documentElement.dataset.theme = message.value.theme;
      post("ready"); return;
    }
    if (!area || message.nonce !== nonce) return;
    if (message.type === "read-content") post("content", area.value, message.requestId);
    else if (message.type === "set-content") area.value = String(message.value ?? "");
    else if (message.type === "focus") area.focus();
    else if (message.type === "set-theme") document.documentElement.dataset.theme = String(message.value ?? "");
    else if (message.type === "action") {
      area.value = action(message.value?.id, area.value);
      post("content-change", area.value); post("dirty", true);
    }
  });
  parent.postMessage({ apiVersion: 1, channel, type: "booted" }, "*");
})();
