import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/**
 * Decoding a hostile image must not be able to take the API down. The native Skia
 * decoder in `@napi-rs/canvas` aborts the process on some truncated JPEG/PNG streams
 * (verified with 6-byte and cut-at-50% JPEGs), and a segfault in a worker thread kills
 * the whole process too. The decode/re-encode therefore runs in a short-lived child
 * process: a crash or timeout is just a rejected upload.
 */
export async function encodeCoverJpeg(data: Buffer): Promise<Buffer> {
  const script = childScript();
  const args = script.endsWith(".ts") ? ["--import", "tsx", "--max-old-space-size=512", script] : ["--max-old-space-size=512", script];
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, KNOWLIFY_COVER_CHILD: "1" },
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("The image could not be decoded"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail();
    }, TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        fail();
        return;
      }
      chunks.push(chunk);
    });
    // Drain stderr so a chatty decoder can never block on a full pipe.
    child.stderr.resume();
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0 || total === 0) {
        fail();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks, total));
    });
    child.stdin.on("error", fail);
    child.stdin.end(data);
  });
}

/** Resolves the compiled child or the TypeScript source when running under tsx/tests. */
function childScript(): string {
  const js = fileURLToPath(new URL("./coverEncoder.child.js", import.meta.url));
  if (existsSync(js)) return js;
  const ts = fileURLToPath(new URL("./coverEncoder.child.ts", import.meta.url));
  if (existsSync(ts)) return ts;
  throw new Error("Cover decoder script not found");
}
