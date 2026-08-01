export type CMakeBuildCommandPlatform = "win32" | "posix";

export function cmakeBuildCommand(
  source: string,
  build: string,
  configuration: string,
  platform: CMakeBuildCommandPlatform = process.platform === "win32" ? "win32" : "posix",
): string {
  const quote = platform === "win32"
    ? (value: string) => `'${value.replaceAll("'", "''")}'`
    : (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return platform === "win32"
    ? `cmake -S ${quote(source)} -B ${quote(build)} -DCMAKE_BUILD_TYPE=${configuration}; if ($LASTEXITCODE -eq 0) { cmake --build ${quote(build)} --config ${configuration} }\r`
    : `cmake -S ${quote(source)} -B ${quote(build)} -DCMAKE_BUILD_TYPE=${configuration} && cmake --build ${quote(build)} --config ${configuration}\r`;
}
