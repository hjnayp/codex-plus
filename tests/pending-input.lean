/- 工程契约：用户 2026-10-03 要求在底部提醒当前有效问题，点击使用原生回答面板。
只显示进行中轮次的未答原生问题；已结束轮次、回答、跳过不继续提醒。
人工模型对应 page/features/pending-input.ts 的 ID 去重、有效状态及导入完成后的点击隔离。
不证明 React 属性、原生模块解析、浏览器事件或原生面板渲染；Chromium 场景提供实现对应证据。
-/
import Std
namespace PendingInput

def ask (questions : List Nat) (id : Nat) : List Nat :=
  id :: questions.filter (· != id)
def answer (questions : List Nat) (id : Nat) : List Nat :=
  questions.filter (· != id)
def eligible (running answered skipped submitting : Bool) : Bool :=
  running && !answered && !skipped && !submitting
def canOpen (disposed sameThread sameClick pending : Bool) : Bool :=
  !disposed && sameThread && sameClick && pending

theorem asked_question_present (questions : List Nat) (id : Nat) :
    id ∈ ask questions id := by simp [ask]
theorem answered_question_absent (questions : List Nat) (id : Nat) :
    id ∉ answer questions id := by simp [answer]
theorem unrelated_question_preserved (questions : List Nat) (id other : Nat) (different : other ≠ id) :
    other ∈ answer questions id ↔ other ∈ questions := by simp [answer, different]
theorem repeated_question_idempotent (questions : List Nat) (id : Nat) :
    ask (ask questions id) id = ask questions id := by simp [ask, List.filter_filter]
theorem ended_question_hidden (a s p : Bool) : eligible false a s p = false := by simp [eligible]
theorem answered_question_hidden (r s p : Bool) : eligible r true s p = false := by simp [eligible]
theorem skipped_question_hidden (r a p : Bool) : eligible r a true p = false := by simp [eligible]
theorem valid_question_visible : eligible true false false false = true := rfl
theorem cleanup_rejects_open (t c p : Bool) : canOpen true t c p = false := by simp [canOpen]
theorem switched_thread_rejects_open (d c p : Bool) : canOpen d false c p = false := by simp [canOpen]
theorem superseded_click_rejects_open (d t p : Bool) : canOpen d t false p = false := by simp [canOpen]
theorem resolved_question_rejects_open (d t c : Bool) : canOpen d t c false = false := by simp [canOpen]
theorem valid_click_opens : canOpen false true true true = true := rfl

#print axioms asked_question_present
#print axioms answered_question_absent
#print axioms unrelated_question_preserved
#print axioms repeated_question_idempotent
#print axioms ended_question_hidden
#print axioms answered_question_hidden
#print axioms skipped_question_hidden
#print axioms valid_question_visible
#print axioms cleanup_rejects_open
#print axioms switched_thread_rejects_open
#print axioms superseded_click_rejects_open
#print axioms resolved_question_rejects_open
#print axioms valid_click_opens
end PendingInput
