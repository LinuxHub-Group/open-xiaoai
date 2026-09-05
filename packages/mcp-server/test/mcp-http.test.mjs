import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import WebSocket from "ws";

test("serves MCP tools through HTTP and proxies a tool call to the device", { timeout: 10_000 }, async () => {
  const mcpPort = await reservePort();
  const devicePort = await reservePort();
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEVICE_WS_HOST: "127.0.0.1",
      DEVICE_WS_PORT: String(devicePort),
      MCP_HOST: "127.0.0.1",
      MCP_PORT: String(mcpPort),
      MCP_AUTH_TOKEN: "mcp-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => {
    stderr += data;
  });

  let device;
  let client;
  try {
    await waitFor(() => stderr.includes("[mcp] listening"));
    const unauthenticatedHealth = await fetch(`http://127.0.0.1:${mcpPort}/health`);
    assert.equal(unauthenticatedHealth.status, 401);
    const authenticatedHealth = await fetch(`http://127.0.0.1:${mcpPort}/health`, {
      headers: { Authorization: "Bearer mcp-secret" },
    });
    assert.equal(authenticatedHealth.status, 200);
    device = new WebSocket(`ws://127.0.0.1:${devicePort}/?device=living-room`);
    await once(device, "open");
    const shellScripts = [];
    device.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (!message.Request) {
        return;
      }
      if (message.Request.command === "get_version") {
        device.send(JSON.stringify({ Response: { id: message.Request.id, code: 0, data: "1.0.0-test" } }));
        return;
      }
      if (message.Request.command === "run_shell") {
        shellScripts.push(message.Request.payload);
        device.send(
          JSON.stringify({
            Response: { id: message.Request.id, data: { stdout: "", stderr: "", exit_code: 0 } },
          }),
        );
        return;
      }
      device.send(JSON.stringify({ Response: { id: message.Request.id, code: -1, msg: "unexpected command" } }));
    });

    client = new Client({ name: "open-xiaoai-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer mcp-secret" } },
      }),
    );
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "xiaoai_version"));

    const result = await client.callTool({
      name: "xiaoai_version",
      arguments: { device: "living-room" },
    });
    assert.deepEqual(result.structuredContent, {
      success: true,
      action: "version",
      version: "1.0.0-test",
    });
    const speak = await client.callTool({
      name: "xiaoai_speak",
      arguments: { device: "living-room", text: "hello'; /bin/false #", blocking: false },
    });
    assert.equal(speak.isError, undefined);
    assert.deepEqual(shellScripts, [
      `ubus call mibrain text_to_speech '{"text":"hello'"'"'; /bin/false #","save":0}'`,
    ]);
  } finally {
    await client?.close();
    device?.close();
    child.kill("SIGTERM");
    await once(child, "exit");
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
