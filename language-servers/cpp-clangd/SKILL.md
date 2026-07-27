---
name: cpp-project-language-service
description: Use Agent K's managed clangd service for an explicitly loaded C or C++ project when semantic results are available.
---

# Agent K C++ project language service

Use the C++ project service for diagnostics, completion, hover, semantic tokens,
definitions, declarations, references, and code navigation only after the user
has loaded a CMake or compilation-database project in Agent K. Do not assume that
opening an isolated `.c`, `.cc`, `.cpp`, or header file loads its project.

Agent K keeps pinned CMake, Ninja, and clangd binaries, the generated CMake
build tree, and the clangd index in application-owned cache directories rather
than modifying the source project. CMake uses a compiler available in the
project environment; on Windows, Agent K initializes an installed Visual Studio
C++ environment when no compiler is already configured. Project loading,
unloading, restarting, cancellation, and transport
traces are UI/slash-command operations; use normal Pi file tools for source edits
and the Agent K project terminal for explicit builds.
