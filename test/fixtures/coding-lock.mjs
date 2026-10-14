import { acquireCodingLock } from "../../src/runtime/coding-lock.ts";

const lease = await acquireCodingLock({
  cwd: process.argv[2],
  baseDir: process.argv[3],
  runId: `worker-${process.pid}`,
  inherited: "[]",
  onWait: () => process.send?.({ type: "waiting" }),
});
process.send?.({ type: "acquired", cwd: lease.cwd });
process.on("message", (message) => {
  if (message === "release") {
    lease.release();
    process.disconnect();
  }
});
