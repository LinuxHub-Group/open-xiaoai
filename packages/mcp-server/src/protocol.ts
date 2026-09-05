import { z } from "zod/v4";

export const DeviceRequestSchema = z.object({
  id: z.string().uuid(),
  command: z.string().min(1),
  payload: z.unknown().optional(),
});
export type DeviceRequest = z.infer<typeof DeviceRequestSchema>;

export const DeviceResponseSchema = z.object({
  id: z.string().uuid(),
  code: z.number().int().optional(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
});
export type DeviceResponse = z.infer<typeof DeviceResponseSchema>;

export const DeviceEventSchema = z.object({
  id: z.string().uuid(),
  event: z.string().min(1),
  data: z.unknown().optional(),
});
export type DeviceEvent = z.infer<typeof DeviceEventSchema>;

export const DeviceStreamSchema = z.object({
  id: z.string().uuid(),
  tag: z.string().min(1),
  bytes: z.array(z.number().int().min(0).max(255)),
  data: z.unknown().optional(),
});
export type DeviceStream = z.infer<typeof DeviceStreamSchema>;

export const AppMessageSchema = z.union([
  z.object({ Request: DeviceRequestSchema }),
  z.object({ Response: DeviceResponseSchema }),
  z.object({ Event: DeviceEventSchema }),
  z.object({ Stream: DeviceStreamSchema }),
]);
export type AppMessage = z.infer<typeof AppMessageSchema>;

export const CommandResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().int(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

export function parseAppMessage(input: string): AppMessage | undefined {
  try {
    const parsed = AppMessageSchema.safeParse(JSON.parse(input));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function parseCommandResult(value: unknown): CommandResult | undefined {
  const parsed = CommandResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
