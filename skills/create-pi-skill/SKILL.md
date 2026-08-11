---
name: create-pi-skill
description: Create or update standalone, reusable Pi Skills with clear triggering metadata, documented workflows, deterministic scripts when needed, and real invocation tests. Use whenever a user asks to create, scaffold, implement, repair, validate, or package a Pi Skill or a project-local .pi/skills package; use the Agent K extension authoring Skill instead for Editor or native language-extension packages.
---

# Create a Pi Skill

Read Pi's `docs/skills.md` completely before implementing. Follow its linked references when they affect the requested package.

## Establish the contract

1. Identify concrete user requests that should trigger the Skill.
2. Separate instructional guidance from behavior that needs a deterministic script.
3. For every script, write down the exact command, operation names, input JSON shape, output JSON shape, error behavior, and one public example before coding.
4. Follow an interface supplied by the user exactly, including object wrappers and property names. If a required interface is ambiguous and interaction is possible, ask for the missing contract. Otherwise choose the smallest sensible contract and document it explicitly.

Treat a script interface as a public API. Do not infer a different shape from prose such as "return records" or silently accept an array where the documented input is an object.

## Create the package

- Use the requested location. For a project-local Skill with no other location specified, create `.pi/skills/<skill-name>/`.
- Name the directory and frontmatter `name` identically using lowercase letters, digits, and hyphens.
- Put only `name` and `description` in YAML frontmatter. Make the description explain both what the Skill does and when it should trigger.
- Add a concise Markdown body that tells a future agent how to use every bundled resource. A frontmatter-only `SKILL.md` is incomplete.
- Add only resources the Skill needs. Prefer `scripts/` for deterministic or repeatedly used behavior, `references/` for detailed knowledge, and `assets/` for files copied into outputs.
- Do not add process-history documents such as README, changelog, or installation notes.

For a deterministic Node runner, prefer this cross-platform interface unless the user specifies another one:

```text
node scripts/run.mjs <operation> '<json-input>'
```

Use Node APIs and argument arrays so the same package works on Windows and Linux. Print exactly one JSON value to stdout on success. Print errors to stderr, produce no success output, and exit non-zero for invalid operations, malformed JSON, invalid input shapes, or bad argument counts. Do not rely on Bash, PowerShell, drive letters, backslashes, global packages, or lifecycle scripts.

## Document and test the public API

In `SKILL.md`, document each script with:

- its relative path and exact command;
- every operation and its input/output JSON shape;
- at least one copyable input/output example;
- validation and failure behavior.

Create tests using the target runtime's standard test tools. Cover the documented example, representative behavior, malformed JSON, unknown operations, invalid shapes, and argument-count errors. Use different valid data for at least one additional case so the test cannot pass by hard-coding the example.

## Verify real use

1. Run all author tests.
2. Execute each documented public example through the real command-line entry point.
3. Parse stdout as JSON and compare the complete value with the documented output, including required wrapper objects.
4. Confirm failures write to stderr and return non-zero.
5. Re-read `SKILL.md` as a new user: it must contain enough information to invoke the Skill without inspecting source code.
6. Report the created path, tested commands, and any deliberate contract choices.
