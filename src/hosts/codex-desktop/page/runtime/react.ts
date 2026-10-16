// 读取 Codex 渲染进程中 React 挂在 DOM 节点上的内部字段；原生组件名经压缩，只能按结构识别。

export type Fiber = {
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  memoizedProps: any;
  memoizedState: any;
};

function internalKey(node: object, prefix: string): string | undefined {
  return Object.keys(node).find((key) => key.startsWith(prefix));
}

export function fiberFor(node: Element | null | undefined): Fiber | null {
  if (!node) return null;
  const key = internalKey(node, "__reactFiber$");
  return key ? (node as any)[key] : null;
}

export function propsFor(node: Element | null | undefined): any {
  if (!node) return null;
  const key = internalKey(node, "__reactProps$");
  return key ? (node as any)[key] : null;
}

/// 从节点向上（先 fiber 链，再父元素）找第一个满足条件的 props。
export function ancestorProps(node: Element | null | undefined, predicate: (props: any) => boolean): any {
  for (let element = node; element; element = element.parentElement) {
    for (let fiber = fiberFor(element); fiber; fiber = fiber.return) {
      if (predicate(fiber.memoizedProps)) return fiber.memoizedProps;
    }
  }
  return null;
}
