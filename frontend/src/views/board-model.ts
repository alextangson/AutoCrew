import { PLATFORM_CATALOG, type Atom, type Content } from "../lib";

export interface BoardPlatform {
  platform: string;
  current: Content;
  contents: Content[];
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 最近修改优先；同一时刻按创建时间、最后按 id 升序，避免接口顺序改变当前稿。 */
function compareContent(left: Content, right: Content): number {
  return (timestamp(right.updatedAt) - timestamp(left.updatedAt)) ||
    (timestamp(right.createdAt) - timestamp(left.createdAt)) ||
    compareId(left.id, right.id);
}

/** 一个平台一个当前稿，其余版本仍全部可访问。平台顺序沿用目录，未知平台按 id 排。 */
export function boardPlatforms(atom: Atom): BoardPlatform[] {
  const grouped = new Map<string, Content[]>();
  for (const content of atom.members) {
    const members = grouped.get(content.platform) ?? [];
    members.push(content);
    grouped.set(content.platform, members);
  }
  const order = new Map<string, number>(PLATFORM_CATALOG.map((platform, index) => [platform.id, index]));
  return [...grouped].map(([platform, members]) => {
    const contents = [...members].sort(compareContent);
    return { platform, current: contents[0], contents };
  }).sort((left, right) =>
    (order.get(left.platform) ?? PLATFORM_CATALOG.length) - (order.get(right.platform) ?? PLATFORM_CATALOG.length) ||
    compareId(left.platform, right.platform),
  );
}
