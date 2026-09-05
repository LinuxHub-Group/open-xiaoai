import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import WebSocket from "ws";

test("serves MCP tools through stdio while receiving a reverse-connected device", { timeout: 10_000 }, async () => {
  const devicePort = await reservePort();
  const client = new Client({ name: "open-xiaoai-stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js", "--stdio"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEVICE_WS_HOST: "127.0.0.1",
      DEVICE_WS_PORT: String(devicePort),
    },
    stderr: "pipe",
  });
  let device;
  try {
    await client.connect(transport);
    device = await connectDevice(devicePort);
    device.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.Request?.command === "get_version") {
        device.send(JSON.stringify({ Response: { id: message.Request.id, code: 0, data: "1.0.0-stdio" } }));
      }
    });

    const result = await client.callTool({
      name: "xiaoai_version",
      arguments: {},
    });
    assert.deepEqual(result.structuredContent, {
      success: true,
      action: "version",
      version: "1.0.0-stdio",
    });
  } finally {
    device?.close();
    await client.close();
  }
});

async function connectDevice(port) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?device=study`);
    try {
      await once(socket, "open");
      return socket;
    } catch {
      socket.terminate();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("stdio MCP server did not start the device WebSocket listener");
}

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
