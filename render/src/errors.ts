/**
 * 输入类错误（manifest/registry/参数/素材不合法）。
 * 与「渲染真崩了」区分开：前者只打人话消息，后者打完整栈——
 * stderr 会被截断进 job（spec §6.1），别让 node 内部栈把真正的原因挤出去。
 */
export class RenderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderInputError';
  }
}
