import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VSWHERE_PATH,
  managedToolchainArchives,
  managedToolchainMarker,
  parseWindowsEnvironment,
  toolchainArchiveFormat,
} from "./toolchain.ts";

test("uses the standard Visual Studio Installer path when vswhere is not discoverable", () => {
  assert.equal(DEFAULT_VSWHERE_PATH, "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe");
});

test("uses standalone clangd on Linux and Windows", () => {
  const linux = managedToolchainArchives("linux");
  const windows = managedToolchainArchives("win32");

  assert.equal(linux.clangd.owner, "clangd");
  assert.equal(linux.clangd.repository, "clangd");
  assert.equal(linux.clangd.asset, "clangd-linux-22.1.6.zip");
  assert.equal(windows.clangd.owner, "clangd");
  assert.equal(windows.clangd.asset, "clangd-windows-22.1.6.zip");
  assert.doesNotMatch(linux.clangd.asset, /LLVM-Linux|clang\+llvm/i);
  assert.doesNotMatch(windows.clangd.asset, /LLVM-Linux|clang\+llvm/i);
  assert.match(managedToolchainMarker("win32"), /clangd-windows-22\.1\.6\.zip/);
});

test("parses the Visual Studio developer environment without pseudo variables", () => {
  assert.deepEqual(parseWindowsEnvironment("Path=C:\\VS\\bin;C:\\Windows\r\nINCLUDE=C:\\VS\\include\r\n=C:=C:\\work\r\n"), {
    Path: "C:\\VS\\bin;C:\\Windows",
    INCLUDE: "C:\\VS\\include",
  });
});

test("routes ZIP tool archives away from tar", () => {
  assert.equal(toolchainArchiveFormat("ninja-linux.zip"), "zip");
  assert.equal(toolchainArchiveFormat("clangd-linux-22.1.6.ZIP"), "zip");
  assert.equal(toolchainArchiveFormat("cmake-linux.tar.gz"), "tar");
  assert.equal(toolchainArchiveFormat("llvm.tar.xz"), "tar");
  assert.throws(() => toolchainArchiveFormat("download.html"), /Unsupported toolchain archive/);
});
