// 注入页面的界面能力共用的生命周期：每个能力只实现 install() 并返回 dispose，
// 替换旧实例、版本幂等、等待 DOM 与登记全局清理入口由这里统一处理。

export type Dispose = () => void;

export interface FeatureDefinition {
  /// 全局清理入口名，守护进程停止或升级时按此调用；同时用于替换已注入的旧实例。
  cleanupKey: string;
  /// 设置后同一版本重复注入直接跳过，用于保留运行中的页面状态。
  version?: { key: string; value: string };
  /// 为 true 时等 head 与 body 就绪后再安装。
  waitForDom?: boolean;
  install(): Dispose | void;
}

type FeatureWindow = Window & Record<string, any>;

export function installFeature({ cleanupKey, version, waitForDom = false, install }: FeatureDefinition): void {
  const page = window as FeatureWindow;
  if (version && page[version.key] === version.value) return;
  try { page[cleanupKey]?.(); } catch { /* 旧版本没有清理契约或已部分清理。 */ }
  if (version) page[version.key] = version.value;

  let disposed = false;
  let dispose: Dispose | void;
  const start = () => {
    if (!disposed) dispose = install();
  };
  page[cleanupKey] = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("DOMContentLoaded", start);
    try {
      dispose?.();
    } finally {
      if (version) page[version.key] = "";
      if (page[cleanupKey]) delete page[cleanupKey];
    }
  };
  if (waitForDom && (!document.head || !document.body)) {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
