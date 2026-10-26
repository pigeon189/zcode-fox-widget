// 输入链路探针的纯逻辑（D057）。
//
// 渲染进程可能「页面 JS 活着但执行队列卡死」：executeJavaScript 既不 resolve
// 也不 reject。这里用 race 把超时变成显式结果，主进程才能累计失败并在连续两拍
// 后重载渲染进程；不能把超时返回的 null 当成「页面还没准备好」静默跳过。

const TIMED_OUT = Symbol('input-probe-timeout')

async function probeOnce(execute, timeoutMs = 5000) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(1, Number(timeoutMs) || 5000))
  })
  try {
    const probe = await Promise.race([Promise.resolve().then(execute), timeout])
    if (probe === TIMED_OUT) return { timedOut: true, probe: null }
    return { timedOut: false, probe }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function createProbeWatchdog({ limit = 2, onStuck } = {}) {
  const max = Math.max(1, Number(limit) || 2)
  let fails = 0
  return {
    ok() {
      fails = 0
    },
    fail() {
      fails += 1
      if (fails < max) return false
      fails = 0
      if (typeof onStuck === 'function') onStuck()
      return true
    },
    get fails() {
      return fails
    },
  }
}

// 鼠标穿透策略的单一权威状态（D057 / 复审 R1-1）。
//
// 「渲染层要交互」有两个写者：渲染层 IPC 'set-interactive'（指针压角色/离开）
// 与 30s 输入探针（页面 DOM 的真实命中）。探针结果必须写回权威状态——之前的
// 实现里探针直接 win.setIgnoreMouseEvents 而不更新状态，300ms zOrder 轮询会
// 用陈旧值把纠正覆盖回去（狐狸每 30s 只有 ≤300ms 可点，或整窗吞点击）。
// 轮询本身只重放当前状态（refresh），不回滚任何写者的纠正。
function createMousePolicy({ apply }) {
  let interactive = false
  let shown = true
  const emit = () => apply(!interactive || !shown)
  return {
    setInteractive(v) {
      interactive = !!v
      emit()
    },
    setShown(v) {
      const was = shown
      shown = !!v
      if (was !== shown) emit()
    },
    // 探针拿到页面 DOM 的真实命中：比渲染层自报的 interactive 更权威。
    // probe 无效（null / 缺 hit）时只重放，不改状态。
    applyProbe(probe) {
      if (probe && typeof probe.hit === 'boolean') interactive = !!probe.hit
      emit()
    },
    refresh() {
      emit()
    },
  }
}

module.exports = { probeOnce, createProbeWatchdog, createMousePolicy, TIMED_OUT }
