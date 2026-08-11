# Editor, LSP, and DAP contracts

The core text Editor routes document open/change/close notifications and semantic requests by language ID to the enabled pack. A custom Editor must be sandboxed, support load/edit/save/theme refresh, and use the same pack worker rather than a second language implementation.

Workers implement `initialize`, `list`, `load`, `status`, `restart`, `unload`, `cancel`, `trace`, `lsp`, `notify`, `shutdown`, and every manifest action method. `trace` returns the bounded structured LSP request/response history needed by the Editor and diagnostics UI. LSP starts only for loaded projects, uses framed JSON-RPC, records bounded traces, rejects files outside a loaded root, and shuts down cleanly.

DAP uses the common session model. Declare provider languages, extensions, markers, modes, priority, adapter command, and optional prepare method. Stop all adapter processes and mark debug sessions ended during disable, upgrade, rollback, or uninstall; never migrate a live debug session.
