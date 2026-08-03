import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { asArray, asObject, asString } from "./utils.js";

export interface MountedVolume {
  name: string;
  path: string;
  device?: string;
  uuid?: string;
}

const SYSTEM_MOUNT_POINTS = new Set(["/", "/boot", "/boot/efi", "/home"]);
const VIRTUAL_DEVICE_TYPES = new Set(["loop", "rom", "zram"]);

export function parseLsblkVolumes(value: unknown): MountedVolume[] {
  const volumes: MountedVolume[] = [];
  const visit = (raw: unknown): void => {
    const device = asObject(raw);
    const devicePath = asString(device.path);
    const label = asString(device.label)?.trim();
    const uuid = asString(device.uuid)?.trim();
    const fstype = asString(device.fstype)?.trim();
    const deviceType = asString(device.type)?.trim();
    const mountPoints = [
      ...asArray(device.mountpoints).flatMap((entry) => typeof entry === "string" ? [entry] : []),
      ...(typeof device.mountpoint === "string" ? [device.mountpoint] : []),
    ];
    if (fstype && fstype !== "swap" && !VIRTUAL_DEVICE_TYPES.has(deviceType ?? "")) {
      for (const path of mountPoints) {
        if (
          !path.startsWith("/") ||
          SYSTEM_MOUNT_POINTS.has(path) ||
          path.startsWith("/var/lib/snapd/") ||
          path.startsWith("/snap/")
        ) continue;
        volumes.push({
          name: label || basename(path) || devicePath || uuid || path,
          path,
          ...(devicePath ? { device: devicePath } : {}),
          ...(uuid ? { uuid } : {}),
        });
      }
    }
    for (const child of asArray(device.children)) visit(child);
  };
  for (const device of asArray(asObject(value).blockdevices)) visit(device);
  return [...new Map(volumes.map((volume) => [volume.path, volume])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function mountedVolumes(platform = process.platform): MountedVolume[] {
  if (platform === "win32") {
    return "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")
      .map((letter) => `${letter}:\\`)
      .filter(existsSync)
      .map((path) => ({ name: path.slice(0, 2), path }));
  }
  if (platform !== "linux") return [];
  const executable = ["/usr/bin/lsblk", "/bin/lsblk"].find(existsSync);
  if (!executable) return [];
  const result = spawnSync(
    executable,
    ["--json", "--output", "PATH,TYPE,FSTYPE,LABEL,UUID,MOUNTPOINTS"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    return parseLsblkVolumes(JSON.parse(result.stdout));
  } catch {
    return [];
  }
}
