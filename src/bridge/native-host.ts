/**
 * Chrome native messaging host entry point.
 *
 * stdin → createFrameDecoder → for each message: parseBridgeMessage + handleBridgeMessage
 * → encodeFrame to stdout. Error handling in two levels:
 *
 * - DECODER ERROR (feed() throws): frame stream is unrecoverable (length-prefix
 *   stream cannot resync) → log to stderr + process.exit(1). Chrome restarts host on next connect.
 * - MESSAGE ERROR (parseBridgeMessage or handleBridgeMessage): encode as BridgeResponse,
 *   write to stdout, continue processing.
 *
 * All diagnostics to stderr only — stdout is the protocol channel.
 * Logic fully tested in T1 (protocol.ts, ingest.ts); this entry is thin (<50 lines per fn).
 */

import process from "node:process";
import { createFrameDecoder, parseBridgeMessage, encodeFrame } from "./protocol.js";
import { handleBridgeMessage } from "./ingest.js";
import type { BridgeResponse } from "./protocol.js";

const decoder = createFrameDecoder();

process.stdin.on("data", (chunk: Buffer) => {
  try {
    // DECODER-FATAL: any feed() throw means frame stream is poisoned.
    const messages = decoder.feed(chunk);

    // MESSAGE-LEVEL: each message is handled independently; errors become BridgeResponse.
    for (const raw of messages) {
      handleMessage(raw).catch((e) => {
        // Should not happen (handleMessage wraps all errors), but log to stderr if it does.
        console.error("Internal error:", String(e));
      });
    }
  } catch (e) {
    // Decoder fatal: log to stderr and exit.
    console.error("Frame decoder fatal:", String(e));
    process.exit(1);
  }
});

async function handleMessage(raw: unknown): Promise<void> {
  try {
    const msg = parseBridgeMessage(raw);
    const response = await handleBridgeMessage(msg);
    process.stdout.write(encodeFrame(response));
  } catch (e) {
    // Message-level error: encode and send BridgeResponse.
    const response: BridgeResponse = { ok: false, type: "error", error: String(e) };
    process.stdout.write(encodeFrame(response));
  }
}

process.stdin.on("error", (e) => {
  console.error("stdin error:", String(e));
  process.exit(1);
});
