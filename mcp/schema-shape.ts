/**
 * MCP 工具契约的「形状」（spec v1.3 §4 / M1）：工具名、参数名、类型、必填、枚举值、长度与格式限制——去掉一切说明文字。
 * 「几选一常量」的两种等价写法（anyOf of const / enum）归一成 enum 再比，所以压缩写法不会被误判为改契约。
 */
type Json = unknown;

function isConstUnion(v: Record<string, unknown>): boolean {
  const any = v.anyOf;
  return Array.isArray(any) && any.length > 0 && any.every((x) => x && typeof x === "object" && "const" in x
    && Object.keys(x).every((k) => k === "const" || k === "type" || k === "description"));
}

/** anyOf-of-const → {type, enum}：接受的值一字不差（同一组常量、同一种类型） */
export function enumify(v: Json): Json {
  if (Array.isArray(v)) return v.map(enumify);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (isConstUnion(o)) {
    const consts = (o.anyOf as Array<{ const: unknown }>).map((x) => x.const);
    const types = [...new Set(consts.map((c) => typeof c))];
    if (types.length === 1 && (types[0] === "string" || types[0] === "number" || types[0] === "boolean")) {
      const { anyOf: _drop, ...rest } = o;
      void _drop;
      return { ...rest, type: types[0], enum: consts };
    }
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, enumify(x)]));
}

/** 说明类关键字：只在「schema 节点」上去掉；`properties` 这类「名字 → schema」的表里，键是参数名，一个都不许去 */
const ANNOTATIONS = new Set(["description", "title", "examples"]);
const NAME_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

/** 去掉说明，只留形状（键排序，便于快照比较） */
export function schemaShape(v: Json): Json {
  if (Array.isArray(v)) return v.map(schemaShape);
  if (!v || typeof v !== "object") return v;
  const o = enumify(v) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(o).filter((k) => !ANNOTATIONS.has(k)).sort().map((k) => [k, NAME_MAPS.has(k) ? namedSchemas(o[k]) : schemaShape(o[k])]));
}

function namedSchemas(v: Json): Json {
  if (!v || typeof v !== "object" || Array.isArray(v)) return schemaShape(v);
  const o = v as Record<string, unknown>;
  return Object.fromEntries(Object.keys(o).sort().map((name) => [name, schemaShape(o[name])]));
}
