// 新增界面能力只在此登记：入口文件、注入键与全局清理入口。加载顺序即登记顺序，清理按相反顺序执行。

export interface PageFeatureEntry {
  /// 打包产物中注入脚本的索引。
  id: string;
  /// Renderers.sources 中的键。
  key: string;
  /// 相对 page/features 的入口文件，由 esbuild 编译为独立 IIFE。
  entry: string;
  cleanup: string;
}

export const PAGE_FEATURES: readonly PageFeatureEntry[] = [
  { id: "model-shortcuts", key: "shortcuts", entry: "model-shortcuts.ts", cleanup: "__CODEX_PLUS_MODEL_SHORTCUTS_CLEANUP__" },
  { id: "reasoning-prefix", key: "reasoningPrefix", entry: "reasoning-prefix.ts", cleanup: "__CODEX_PLUS_REASONING_PREFIX_CLEANUP__" },
  { id: "hash-highlights", key: "hashHighlights", entry: "hash-highlights.ts", cleanup: "__CODEX_PLUS_HASH_HIGHLIGHTS_CLEANUP__" },
  { id: "message-avatars", key: "messageAvatars", entry: "message-avatars.ts", cleanup: "__CODEX_PLUS_MESSAGE_AVATARS_CLEANUP__" },
  { id: "pending-input", key: "pendingInput", entry: "pending-input.ts", cleanup: "__CODEX_PLUS_PENDING_INPUT_CLEANUP__" },
  { id: "project-branches", key: "projectBranches", entry: "project-branches.ts", cleanup: "__CODEX_PLUS_PROJECT_BRANCHES_CLEANUP__" },
];
