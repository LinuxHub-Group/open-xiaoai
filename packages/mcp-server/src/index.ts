import { createServer, type Server } from "node:http";

import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { DeviceGateway } from "./device.js";
import { createXiaoaiMcpServer } from "./tools.js";

const stdioMode = process.argv.includes("--stdio");
const deviceHost = process.env.DEVICE_WS_HOST ?? "0.0.0.0";
const devicePort = parsePort(process.env.DEVICE_WS_PORT, 4399, "DEVICE_WS_PORT");
const deviceToken = process.env.DEVICE_TOKEN;
const mcpHost = process.env.MCP_HOST ?? "127.0.0.1";
const mcpPort = parsePort(process.env.MCP_PORT, 8080, "MCP_PORT");
const mcpToken = process.env.MCP_AUTH_TOKEN;

if (!stdioMode && mcpHost !== "127.0.0.1" && mcpHost !== "::1" && mcpHost !== "localhost" && !mcpToken) {
  throw new Error("非 loopback 的 MCP_HOST 必须设置 MCP_AUTH_TOKEN");
}

const devices = new DeviceGateway();
devices.on("deviceConnected", (device) => {
  console.error(`[device] connected: ${device.id} (${device.remoteAddress ?? "unknown"})`);
});
devices.on("deviceDisconnected", (deviceId) => {
  console.error(`[device] disconnected: ${deviceId}`);
});
devices.on("deviceEvent", (deviceId, event) => {
  console.error(`[device] event from ${deviceId}: ${event.event}`);
});

await devices.start({ host: deviceHost, port: devicePort, token: deviceToken });
console.error(`[device] listening on ws://${deviceHost}:${devicePort}`);

if (stdioMode) {
  const server = createXiaoaiMcpServer(devices);
  await server.connect(new StdioServerTransport());
  installShutdownHandler();
} else {
  const mcpHandler = createMcpHandler(() => createXiaoaiMcpServer(devices));
  const httpServer = createServer(
    toNodeHandler({
      fetch: async (request) => {
        const url = new URL(request.url);
        if (mcpToken && request.headers.get("authorization") !== `Bearer ${mcpToken}`) {
          return new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": "Bearer" },
          });
        }
        if (url.pathname === "/health" && request.method === "GET") {
          return Response.json({ devices: devices.listDevices(), status: "ok" });
        }
        if (url.pathname !== "/mcp") {
          return new Response("Not Found", { status: 404 });
        }
        return mcpHandler.fetch(request);
      },
    }),
  );

  await listen(httpServer, mcpHost, mcpPort);
  console.error(`[mcp] listening on http://${mcpHost}:${mcpPort}/mcp`);
  installShutdownHandler(httpServer);
}

function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} 必须是 1 到 65535 的整数`);
  }
  return port;
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

function installShutdownHandler(httpServer?: Server): void {
  let stopping = false;
  const shutdown = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await devices.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
