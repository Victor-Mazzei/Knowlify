#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible provider for the screenshot capture.
 *
 * It streams one short, neutral answer about Darcy's first proposal so the reader
 * screenshot can show a grounded tutor reply with citation markers. The port is
 * ephemeral; the chosen port is written to the file passed as argv[2].
 *
 * Usage:
 *   node scripts/site-screenshots/fake-llm.mjs /tmp/knowlify/ge-site-llm.port
 */
import http from "node:http";
import { writeFileSync } from "node:fs";

const portFile = process.argv[2];
if (!portFile) throw new Error("usage: fake-llm.mjs <port-file>");

const answer =
  "Darcy's first proposal fails because he presents it as a favor to Elizabeth rather than a meeting of equals. " +
  "Austen shows his pride in the way he lists the obstacles he has overcome, and Elizabeth's refusal is the first time she answers him plainly [1]. " +
  "The scene also sets up the novel's argument that love requires both people to revise their first impressions [2].";

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "tutor-demo", object: "model" }] }));
    return;
  }
  if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const words = answer.split(" ");
    let index = 0;
    const timer = setInterval(() => {
      if (index === words.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        clearInterval(timer);
        return;
      }
      const text = (index === 0 ? "" : " ") + words[index++];
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
    }, 18);
    req.on("close", () => clearInterval(timer));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found" } }));
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  writeFileSync(portFile, String(port));
  console.log(`fake llm on ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
