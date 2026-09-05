import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import WebSocket from "ws";

import { DeviceGateway } from "../dist/device.js";

test("accepts an outbound device connection and completes an RPC call", async () => {
  const gateway = new DeviceGateway();
  await gateway.start({ host: "127.0.0.1", port: 0, token: "device-secret" });

  const device = new WebSocket(`ws://127.0.0.1:${gateway.listeningPort()}/?device=living-room&token=device-secret`);
  try {
    await once(device, "open");
    await waitFor(() => gateway.listDevices().length === 1);

    device.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (!message.Request) {
        return;
      }
      device.send(
        JSON.stringify({
          Response: {
            id: message.Request.id,
            code: 0,
            data: "1.0.0-test",
          },
        }),
      );
    });

    const response = await gateway.call("living-room", "get_version");
    assert.equal(response.data, "1.0.0-test");
    assert.deepEqual(gateway.listDevices().map((entry) => entry.id), ["living-room"]);
  } finally {
    device.close();
    await gateway.stop();
  }
});

async function waitFor(condition) {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
