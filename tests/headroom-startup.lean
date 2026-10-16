/- 工程契约 SC-CODEX-PLUS-065：start 不检查 Headroom，也不退出或重启 Codex。
   人工顺序模型覆盖复用、普通模式拒绝及新守护进程启动。
   不证明 JS、CDP 或真实应用等价；隔离 CLI 测试验证实现对应关系。 -/
namespace HeadroomStartup

inductive StartAction where
  | reuse
  | rejectNormalMode
  | spawnDaemon
  deriving DecidableEq

def startAction (daemonRunning cdpReady codexRunning : Bool) : StartAction :=
  if daemonRunning && cdpReady then .reuse
  else if codexRunning && !cdpReady then .rejectNormalMode
  else .spawnDaemon

-- Headroom 状态不参与 start 决策，三种结果均不允许退出已有应用。
def quitsCodex (_ : StartAction) : Bool := false

theorem running_instance_reused (codexRunning : Bool) :
    startAction true true codexRunning = .reuse := by simp [startAction]

theorem normal_mode_rejected (daemonRunning : Bool) :
    startAction daemonRunning false true = .rejectNormalMode := by simp [startAction]

theorem cold_start : startAction false false false = .spawnDaemon := by rfl

theorem start_never_quits (daemonRunning cdpReady codexRunning : Bool) :
    quitsCodex (startAction daemonRunning cdpReady codexRunning) = false := by rfl

#print axioms running_instance_reused
#print axioms normal_mode_rejected
#print axioms cold_start
#print axioms start_never_quits

end HeadroomStartup
