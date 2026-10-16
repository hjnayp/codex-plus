/// 节点在文档中且实际渲染，排除隐藏、惰性和对辅助技术隐藏的子树。
export function visible(node: Element | null | undefined): node is Element {
  return Boolean(node?.isConnected && node.getClientRects().length > 0
    && !node.closest("[hidden], [inert], [aria-hidden='true']"));
}

/// 注入一段样式并返回节点，调用方在 dispose 时移除。
export function appendStyle(id: string, css: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.append(style);
  return style;
}
