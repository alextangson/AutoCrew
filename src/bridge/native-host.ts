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
 * Responses are serialized in request order via a promise queue — BridgeResponse
 * carries no correlation id, so out-of-order replies would break clients. The queue
 * also keeps journal writes sequential.
 *
 * All diagnostics to stderr only — stdout is the protocol channel.
 * Logic fully tested in T1 (protocol.ts, ingest.ts); this entry is thin (<50 lines per fn).
 */

import process from "node:process";
import { createFrameDecoder, parseBridgeMessage, encodeFrame } from "./protocol.js";
import { handleBridgeMessage } from "./ingest.js";
import type { BridgeResponse } from "./protocol.js";

const decoder = createFrameDecoder();

// Promise queue: each message is handled (and its response written) strictly
// after the previous one completes — request order = response order.
let queue: Promise<void> = Promise.resolve();

process.stdin.on("data", (chunk: Buffer) => {
  try {
    // DECODER-FATAL: any feed() throw means frame stream is poisoned.
    const messages = decoder.feed(chunk);

    // MESSAGE-LEVEL: errors become BridgeResponse inside handleMessage.
    for (const raw of messages) {
      queue = queue
        .then(() => handleMessage(raw))
        .catch((e) => {
          // Should not happen (handleMessage wraps all errors), but log if it does.
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

// Chrome closed the pipe (extension disconnected): EPIPE on stdout / stdin end
// are normal shutdown, not errors — exit clean so Chrome can restart us later.
process.stdout.on("error", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));

process.stdin.on("error", (e) => {
  console.error("stdin error:", String(e));
  process.exit(1);
});
