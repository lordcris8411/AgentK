# Contributing to AgentK

AgentK is an independent desktop client for Pi. Changes must stay within the public Pi RPC boundary and must not require a
patched Pi source tree.

```bash
npm ci --ignore-scripts
npm run prepare:native
npm run build:editors
npm run check
npm test
```

Keep pull requests focused and document any minimum Pi version or optional RPC capability they require.
Editor packages must remain independent: keep implementation and CSS inside each package, declare exact-version shared
dependencies in `editor.json`, and do not add a common Editor UI base class or imports between plugins.
