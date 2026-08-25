/**
 * 选段勾选的「脏增量」(转写纠错 spec §6)——**纯函数,不碰 DOM 不碰 IPC**。
 *
 * 为什么不是「新数据到了就 setKept(新 keeps)」:门上多了改字与预览之后,数据会在人
 * 勾到一半时被刷新(自己改了一个错字、后台重渲完预览、冲突后重拉),那一刷就把还没
 * 提交的勾选全抹了——人以为自己在挑,其实每改一个字就白挑一轮。
 *
 * 也不是「求并」(旧勾选 ∪ 新 keeps):求并会把人刚刚**取消**的那一句加回来,
 * 比抹掉更糟——它是静默地违背了刚做出的决定。
 *
 * 所以只记「人显式动过的那几个 id 变成了什么」,新基线到达后把这份增量套上去:
 * 没动过的跟着服务端最新版走,动过的以人的为准。
 */

/** 人显式 toggle 过的增量:id → 现在是留(true)还是不留(false) */
export type KeepDelta = ReadonlyMap<string, boolean>;

export interface KeepBaseline {
  /** 服务端最新那版的 keeps */
  keeps: readonly string[];
  /** 这一版列表里全部单元的 id——增量只对活着的 id 生效 */
  ids: readonly string[];
  delta: KeepDelta;
}

/**
 * 新基线 + 增量 = 界面上此刻的勾选。
 *
 * 基线里不存在的 id 一律丢弃(keeps 与增量都是):重跑转写/重跑粗剪会整代换掉单元,
 * `unit-0001` 这种编号还会跨代复用——套一个上一代的勾选到新一代的同名单元上,
 * 等于替人做了他没做过的决定(spec §7 的 id 跨代复用陷阱)。
 */
export function keptWithDelta(input: KeepBaseline): Set<string> {
  const known = new Set(input.ids);
  const kept = new Set(input.keeps.filter((id) => known.has(id)));
  for (const [id, on] of input.delta) {
    if (!known.has(id)) continue;
    if (on) kept.add(id);
    else kept.delete(id);
  }
  return kept;
}

/** 记一次显式 toggle(全选/全不留 = 对每一行各记一次),返回新的增量 */
export function withToggle(delta: KeepDelta, changes: Iterable<[string, boolean]>): KeepDelta {
  const next = new Map(delta);
  for (const [id, on] of changes) next.set(id, on);
  return next;
}
