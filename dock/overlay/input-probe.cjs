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

module.exports = { probeOnce, createProbeWatchdog, TIMED_OUT }
