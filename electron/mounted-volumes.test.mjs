import assert from "node:assert/strict";
import test from "node:test";
import { parseLsblkVolumes } from "../.electron-dist/mounted-volumes.js";

test("maps mounted Linux partitions to labels and paths", () => {
  const volumes = parseLsblkVolumes({
    blockdevices: [{
      path: "/dev/sda",
      children: [
        { path: "/dev/sda1", fstype: "ext4", label: "data_store", uuid: "data-uuid", mountpoints: ["/run/media/user/data-uuid"] },
        { path: "/dev/sda2", fstype: "ext4", label: "work_space", uuid: "work-uuid", mountpoints: ["/run/media/user/work-uuid"] },
        { path: "/dev/sda3", fstype: "ext4", label: "offline", uuid: "offline-uuid", mountpoints: [null] },
      ],
    }, {
      path: "/dev/nvme0n1",
      type: "part",
      fstype: "btrfs",
      uuid: "system-uuid",
      mountpoints: ["/", "/home"],
    }, {
      path: "/dev/loop0",
      type: "loop",
      fstype: "squashfs",
      mountpoints: ["/var/lib/snapd/snap/example/1"],
    }],
  });
  assert.deepEqual(volumes, [
    { name: "data_store", path: "/run/media/user/data-uuid", device: "/dev/sda1", uuid: "data-uuid" },
    { name: "work_space", path: "/run/media/user/work-uuid", device: "/dev/sda2", uuid: "work-uuid" },
  ]);
});

test("uses the mount directory when a Linux volume has no label", () => {
  assert.deepEqual(parseLsblkVolumes({
    blockdevices: [{ path: "/dev/sdb1", fstype: "exfat", uuid: "4E21-0000", mountpoints: ["/run/media/user/4E21-0000"] }],
  }), [{ name: "4E21-0000", path: "/run/media/user/4E21-0000", device: "/dev/sdb1", uuid: "4E21-0000" }]);
});
