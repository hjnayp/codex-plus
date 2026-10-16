/-
消息头像连续角色分组的回归证明，对应 src/hosts/codex-desktop/page/features/message-avatars.ts 的组首选择行为。
批准摘要: bba1f825521771e70dc9c06e417ba19254f75672691b9e199ee32a6d85bef1d1
模型对应 message-avatars.ts 的 ordered 消息扫描：previousRole 初始为空，
每次读取角色后更新 previousRole，只有与前一个角色不同的消息进入 candidates。
证明连续组只选择首条，与窗口可见性无关；不证明 DOM 消息识别、CSS 坐标或存储。
这些边界通过真实浏览器回归与桌面运行检查核验。
-/
namespace MessageAvatarGroups

inductive Role where
  | user
  | assistant
  deriving DecidableEq

def showsAvatar (previous : Option Role) (current : Role) : Bool :=
  if previous = some current then false else true

def groupStarts : Option Role → List Role → List Bool
  | _, [] => []
  | previous, current :: rest =>
    showsAvatar previous current :: groupStarts (some current) rest

theorem first_message_shown (role : Role) : showsAvatar none role = true := by
  simp [showsAvatar]

theorem same_role_hidden (role : Role) : showsAvatar (some role) role = false := by
  simp [showsAvatar]

theorem switched_role_shown (previous current : Role) (h : previous ≠ current) :
    showsAvatar (some previous) current = true := by
  simp [showsAvatar, h]

theorem decisions_match_message_count (roles : List Role) (previous : Option Role) :
    (groupStarts previous roles).length = roles.length := by
  induction roles generalizing previous with
  | nil => rfl
  | cons role rest ih => simp [groupStarts, ih]

theorem continuing_run_hidden (role : Role) (count : Nat) :
    groupStarts (some role) (List.replicate count role) = List.replicate count false := by
  induction count with
  | zero => rfl
  | succ count ih => simp [List.replicate_succ, groupStarts, same_role_hidden, ih]

theorem consecutive_run_has_only_first_avatar (role : Role) (count : Nat) :
    groupStarts none (List.replicate (count + 1) role) =
      true :: List.replicate count false := by
  simp [List.replicate_succ, groupStarts, first_message_shown, continuing_run_hidden]

#print axioms first_message_shown
#print axioms same_role_hidden
#print axioms switched_role_shown
#print axioms decisions_match_message_count
#print axioms continuing_run_hidden
#print axioms consecutive_run_has_only_first_avatar
end MessageAvatarGroups
