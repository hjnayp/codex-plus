/- 工程契约：用户 2026-10-14 要求 #l/#m/#h/#x 切换实际思考强度并从 prompt 移除。
人工模型对应 core/prompt-directives.ts 的 DIRECTIVE_EFFORTS 和 page/features/reasoning-prefix.ts 的 current() 提交门禁。
只证明映射及门禁必要条件，不证明 JS/Lean 等价、React 更新、编辑器事务、事件或实际请求。
实现对应证据来自 Chromium 场景与真实应用的本地发送前检查。
-/
import Std
namespace ReasoningPrefix

inductive Effort where
  | low | medium | high | xhigh
  deriving DecidableEq

def effort (marker : Char) : Option Effort :=
  match marker with
  | 'l' => some .low
  | 'm' => some .medium
  | 'h' => some .high
  | 'x' => some .xhigh
  | _ => none

def canSubmit (disposed canceled visible sameController sameThread sameDoc committed : Bool) : Bool :=
  !disposed && !canceled && visible && sameController && sameThread && sameDoc && committed

theorem low_mapping : effort 'l' = some .low := rfl
theorem medium_mapping : effort 'm' = some .medium := rfl
theorem high_mapping : effort 'h' = some .high := rfl
theorem xhigh_mapping : effort 'x' = some .xhigh := rfl
theorem unknown_marker : effort 'z' = none := rfl
theorem uppercase_is_literal : effort 'H' = none := rfl

theorem submit_requires_all_guards (d c v controller thread doc committed : Bool) :
    canSubmit d c v controller thread doc committed = true ↔
    d = false ∧ c = false ∧ v = true ∧ controller = true ∧ thread = true ∧ doc = true ∧ committed = true := by
  simp [canSubmit, Bool.and_eq_true, and_assoc]

theorem supported_current_submission : canSubmit false false true true true true true = true := rfl

#print axioms low_mapping
#print axioms medium_mapping
#print axioms high_mapping
#print axioms xhigh_mapping
#print axioms unknown_marker
#print axioms uppercase_is_literal
#print axioms submit_requires_all_guards
#print axioms supported_current_submission
end ReasoningPrefix
