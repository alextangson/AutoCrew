/**
 * JSON 往返一次，把 own symbol 与 undefined 甩掉。
 *
 * AutoCrew 的参数 schema 是 TypeBox 造的，对象上挂着 `Symbol(TypeBox.Kind)` 一类的
 * own symbol。两个消费面都要求纯 JSON：dsh 注册表投影 schema 时见到 symbol 直接抛
 * `parameters must be lossless JSON before schema projection`；MCP 宿主拿到的
 * `tools/list` / `tools/call` 结果也必须是能原样序列化的 JSON（否则字段会在传输里
 * 静默消失）。所以这个函数是两边共用的，不是 dsh 私有的。
 */
export function toLosslessJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
