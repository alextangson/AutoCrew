import {
  BOARD_COLUMNS,
  DROP_TARGET_STATUS,
  PLATFORM_CATALOG,
  STATUS_COLUMN,
  type Atom,
  type Content,
  type Topic,
} from "../lib";

export interface BoardPlatform {
  platform: string;
  current: Content;
  contents: Content[];
}

export interface BoardTopic {
  atomKey: string;
  topic: Topic | null;
  title: string;
  platforms: BoardPlatform[];
  members: Content[];
  columnIndex: number;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contentColumn(status: string): number {
  const index = STATUS_COLUMN[status];
  return typeof index === "number" ? index : 1;
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

/** 一主题只出现一次；按各平台当前稿中最早未完成阶段落列，历史稿不拖住进度。 */
export function boardColumns(atoms: Atom[]): BoardTopic[][] {
  const columns: BoardTopic[][] = BOARD_COLUMNS.map(() => []);
  for (const atom of atoms) {
    const platforms = boardPlatforms(atom);
    const columnIndex = platforms.length === 0 ? 0 : platforms.reduce(
      (earliest, platform) => Math.min(earliest, contentColumn(platform.current.status)),
      BOARD_COLUMNS.length - 1,
    );
    const newest = platforms.map((platform) => platform.current).sort(compareContent)[0];
    columns[columnIndex].push({
      atomKey: atom.key,
      topic: atom.topic,
      title: atom.topic?.title || newest?.title || "（无标题）",
      platforms,
      members: [...atom.members],
      columnIndex,
    });
  }
  return columns;
}

/** 同列移动只改变位置意图，不将剪辑等细分状态重置为该列入口。 */
export function boardMoveTarget(content: Pick<Content, "status">, columnKey: string): string | null {
  const columnIndex = BOARD_COLUMNS.findIndex((column) => column.key === columnKey);
  if (columnIndex < 0 || columnIndex === contentColumn(content.status)) return null;
  return DROP_TARGET_STATUS[columnKey] ?? null;
}
