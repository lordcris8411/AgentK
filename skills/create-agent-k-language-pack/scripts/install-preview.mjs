const { manifest } = await (await import("./validate.mjs")).validatePack(process.argv[2] ?? ".");
console.log(JSON.stringify({ id: manifest.id, version: manifest.version, displayName: manifest.displayName, platforms: manifest.platforms, permissions: manifest.permissions, toolchains: manifest.toolchains, actions: manifest.actions.map(({ id }) => id), confirmationRequired: true }, null, 2));
