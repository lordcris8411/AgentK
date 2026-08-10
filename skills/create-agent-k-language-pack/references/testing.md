# Test and certification gates

Public and hidden contract tests must reject path traversal, duplicate language IDs/actions, invalid worker paths, missing Skills, unversioned tools, undeclared permissions, unsupported platforms, and malformed action arguments.

Exercise install, enable, upgrade, failed-upgrade rollback, disable, and uninstall without restarting Agent K. Assert that workers, Skills, Editor contributions, actions, LSP processes, DAP sessions, and tasks appear and disappear together. Snapshot the source tree before and after toolchain, build, test, and indexing operations.

Run true Editor → host → worker → LSP/DAP calls. Validate request, response, and visible result; text claiming a call occurred is a failure. A Windows-built artifact earns dual-platform certification only after that identical artifact installs, cold-starts, builds, tests, debugs where supported, and uninstalls on Windows x64 and Ubuntu x64.
