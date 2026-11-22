import { parentPort, workerData } from "node:worker_threads";

// The pdf.js worker runs in its own realm, so the main-thread polyfills never
// reach it. Remove the ES Upsert methods first, then load the worker build the
// app points pdf.js at, and report what that build installed.
for (const proto of [Map.prototype, WeakMap.prototype]) {
  for (const name of ["getOrInsert", "getOrInsertComputed"]) delete proto[name];
}

const before = typeof Map.prototype.getOrInsertComputed;
await import(workerData.workerModule);

parentPort.postMessage({
  before,
  mapComputed: typeof Map.prototype.getOrInsertComputed,
  mapInsert: typeof Map.prototype.getOrInsert,
  weakComputed: typeof WeakMap.prototype.getOrInsertComputed,
  weakInsert: typeof WeakMap.prototype.getOrInsert,
});
