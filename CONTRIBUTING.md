# Contributing to AgentK

AgentK is an independent desktop client for Pi. Changes must stay within the public Pi RPC boundary and must not require a
patched Pi source tree.

```bash
npm ci --ignore-scripts
npm run prepare:native
npm run check:desktop
npm run check
npm test
```

Keep pull requests focused and document any minimum Pi version or optional RPC capability they require.
