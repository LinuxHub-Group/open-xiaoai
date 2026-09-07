import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("loads MCP listener configuration and authentication from .env", { timeout: 10_000 }, async () => {
  const devicePort = await reservePort();
  const mcpPort = await reservePort();
  const directory = await mkdtemp(join(tmpdir(), "open-xiaoai-mcp-env-"));
  await writeFile(
    join(directory, ".env"),
    [
      "DEVICE_WS_HOST=127.0.0.1",
      `DEVICE_WS_PORT=${devicePort}`,
      "DEVICE_TOKEN=device-secret",
      "MCP_HOST=127.0.0.1",
      `MCP_PORT=${mcpPort}`,
      "MCP_AUTH_TOKEN=mcp-secret",
    ].join("\n"),
  );

  const child = spawn(process.execPath, [join(packageRoot, "dist/index.js")], {
    cwd: directory,
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => {
    stderr += data;
  });

  try {
    await waitFor(() => stderr.includes(`[mcp] listening on http://127.0.0.1:${mcpPort}/mcp`));
    const unauthenticated = await fetch(`http://127.0.0.1:${mcpPort}/health`);
    assert.equal(unauthenticated.status, 401);

    const authenticated = await fetch(`http://127.0.0.1:${mcpPort}/health`, {
      headers: { Authorization: "Bearer mcp-secret" },
    });
    assert.equal(authenticated.status, 200);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await rm(directory, { force: true, recursive: true });
  }
});

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("unable to reserve a TCP port");
  }
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitFor(condition) {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("server did not become ready before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
