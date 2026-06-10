/**
 * Chrome native messaging 帧协议：4 字节 LE 长度前缀 + UTF-8 JSON。
 * 所有信任边界校验在 parseBridgeMessage 处理，encodeFrame/createFrameDecoder 是纯 I/O 工具。
 */

export interface IngestRowsMessage {
  type: "ingest_rows";
  platform: string;
  rows: Array<Record<string, string>>;
}

export interface PingMessage {
  type: "ping";
}

export type BridgeMessage = IngestRowsMessage | PingMessage;

export interface BridgeResponse {
  ok: boolean;
  type: string;
  data?: unknown;
  error?: string;
}

const MAX_FRAME_BYTES = 10 * 1024 * 1024; // 10 MB guard

/** 4 字节小端长度前缀 + UTF-8 JSON（Chrome native messaging 线格式） */
export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * 增量解码器：feed(chunk) 返回完整消息数组（处理半包/粘包）。
 * 非法长度（>10 MB）或非法 JSON → 抛带上下文错误。
 *
 * 错误致命性契约：任何 feed() 抛错即视为帧流损坏——调用方必须丢弃本解码器并
 * 终止连接（进程退出由 Chrome 重启），不得捕获后继续 feed。内部 poisoned 标志
 * 强制此契约：抛错后任何后续 feed() 一律抛"连接已损坏"。
 * 同一次 feed() 中先解出的消息也随抛错丢失——帧边界已不可信，半批投递更危险。
 */
export function createFrameDecoder(): { feed(chunk: Buffer): unknown[] } {
  let buf = Buffer.alloc(0);
  let poisoned = false;

  return {
    feed(chunk: Buffer): unknown[] {
      if (poisoned) {
        throw new Error("帧流连接已损坏（此前 feed 已抛错）：丢弃本解码器并终止连接");
      }
      buf = Buffer.concat([buf, chunk]);
      const results: unknown[] = [];

      while (buf.length >= 4) {
        const bodyLen = buf.readUInt32LE(0);

        if (bodyLen > MAX_FRAME_BYTES) {
          poisoned = true;
          throw new Error(
            `帧大小 ${bodyLen} 字节超过 ${MAX_FRAME_BYTES} 字节上限，拒绝解码（防内存炸）`,
          );
        }

        if (buf.length < 4 + bodyLen) break; // 还没收齐，等下一个 chunk

        const body = buf.subarray(4, 4 + bodyLen).toString("utf8");
        buf = buf.subarray(4 + bodyLen);

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          poisoned = true;
          throw new Error(`JSON 解析失败：${String(e)}（body 前 80 字符：${body.slice(0, 80)}）`);
        }

        results.push(parsed);
      }

      return results;
    },
  };
}

/** 信任边界：校验 raw 结构，返回类型化 BridgeMessage；非法 → 抛中文错误 */
export function parseBridgeMessage(raw: unknown): BridgeMessage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("BridgeMessage 必须是对象");
  }

  const obj = raw as Record<string, unknown>;

  if (obj["type"] === "ping") {
    return { type: "ping" };
  }

  if (obj["type"] === "ingest_rows") {
    if (typeof obj["platform"] !== "string" || !obj["platform"]) {
      throw new Error("ingest_rows 消息缺少 platform 字段");
    }
    if (!Array.isArray(obj["rows"])) {
      throw new Error("ingest_rows 消息的 rows 必须是数组");
    }
    for (let i = 0; i < (obj["rows"] as unknown[]).length; i++) {
      const row = (obj["rows"] as unknown[])[i];
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error(`rows[${i}] 必须是 {列名: 值} 对象`);
      }
    }
    return {
      type: "ingest_rows",
      platform: obj["platform"] as string,
      rows: obj["rows"] as Array<Record<string, string>>,
    };
  }

  throw new Error(`未知 type：${String(obj["type"])}（支持：ping / ingest_rows）`);
}
