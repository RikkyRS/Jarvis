import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundMessage } from "./index.js";

/**
 * WhatsApp Cloud API webhook helpers. Transport stays outside the core: whoever hosts the HTTP
 * endpoint (bound to loopback or behind an authenticated tunnel) must call verifySignature first.
 */
export function verifySignature(
  rawBody: string | Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith("sha256=") || appSecret.length === 0) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  let received: Buffer;
  try {
    received = Buffer.from(header.slice("sha256=".length), "hex");
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}

type WebhookPayload = {
  entry?: {
    changes?: {
      value?: {
        messages?: {
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
        }[];
      };
    }[];
  }[];
};

/** Extracts text messages only; media, reactions and unknown types are ignored, never executed. */
export function parseWebhook(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const data = payload as WebhookPayload;
  for (const entry of data?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        if (m.type !== "text" || !m.id || !m.from || typeof m.text?.body !== "string") continue;
        const seconds = Number(m.timestamp);
        out.push({
          channel: "whatsapp",
          externalId: m.id,
          sender: m.from,
          conversationId: m.from,
          receivedAt: new Date(
            Number.isFinite(seconds) ? seconds * 1000 : Date.now(),
          ).toISOString(),
          text: m.text.body,
        });
      }
    }
  }
  return out;
}
