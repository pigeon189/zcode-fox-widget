// 宠物状态机（D025）：idle / attached / floating 三态。
//
// 纯函数：transition(state, event, opts) → state。所有副作用（写设置、推送 SSE）
// 由调用方做。这样表驱动测试与随机序列测试可以只针对这一层。
//
// 不变量：
//   · attached 必须有 agentId 与 hwnd；
//   · floating 必须有 profileOf（从 idle 拖到桌面时记 'generic'）；
//   · 档案属主（profileOf）只在 drop-on-agent / auto-attach / reset 时变化；
//   · 关闭 agent 窗口 → floating，不是 idle（保留上一个 agent 的档案）。

import { normalizePet } from './settings.mjs'

export const PET_EVENTS = [
  'drop-on-agent',
  'drop-on-desktop',
  'agent-window-gone',
  'agent-window-back',
  'auto-attach',
  'reset',
  'move',
]

export function initialPet() {
  return normalizePet({})
}

function copyRect(rect) {
  if (!rect || typeof rect !== 'object') return undefined
  return {
    x: Number(rect.x) || 0,
    y: Number(rect.y) || 0,
    width: Number(rect.width || rect.w) || 0,
    height: Number(rect.height || rect.h) || 0,
  }
}

function attached(state, agentId, hwnd, rect, display) {
  if (!agentId || !hwnd) return state
  return normalizePet({
    ...state,
    mode: 'attached',
    agentId,
    lastAgentId: agentId,
    profileOf: agentId,
    hwnd,
    rect: rect === undefined ? state.rect : copyRect(rect),
    display: display === undefined ? state.display : display,
  })
}

export function transition(state, event, opts = {}) {
  const s = normalizePet(state)
  const e = event && typeof event === 'object' ? event : {}
  switch (e.type) {
    case 'drop-on-agent':
    case 'auto-attach':
      if (e.type === 'auto-attach' && opts.requireIdle !== false && s.mode !== 'idle') return s
      return attached(s, String(e.agentId || ''), String(e.hwnd || ''), e.rect, e.display)

    case 'drop-on-desktop': {
      const profileOf = s.profileOf || s.agentId || s.lastAgentId || 'generic'
      return normalizePet({
        ...s,
        mode: 'floating',
        agentId: '',
        lastAgentId: s.lastAgentId || s.agentId || '',
        profileOf,
        rect: e.rect === undefined ? s.rect : copyRect(e.rect),
        display: e.display === undefined ? s.display : e.display,
      })
    }

    case 'agent-window-gone': {
      if (s.mode !== 'attached') return s
      return normalizePet({
        ...s,
        mode: 'floating',
        agentId: '',
        lastAgentId: s.agentId || s.lastAgentId,
        profileOf: s.profileOf || s.agentId,
        // attached 的 rect 是宿主窗口矩形，不是角色位置；直接带进 floating
        // 会让角色跳到宿主原来的屏幕坐标。清空后由浮层落到右下角兜底。
        rect: null,
      })
    }

    case 'agent-window-back': {
      if (s.mode === 'attached') return s
      if (opts.reattach === false) return s
      const want = s.profileOf || s.lastAgentId
      if (!want || String(e.agentId || '') !== want) return s
      return attached(s, want, String(e.hwnd || ''), e.rect, e.display)
    }

    case 'reset':
      return normalizePet({})

    case 'move': {
      if (!e.rect && e.display === undefined) return s
      return normalizePet({
        ...s,
        rect: e.rect === undefined ? s.rect : copyRect(e.rect),
        display: e.display === undefined ? s.display : e.display,
      })
    }

    default:
      return s
  }
}

// 启动恢复：持久化的 attached 在启动时窗口已不在 → 转 floating；
// 若同一 agent 的窗口仍在（按身份键），保持 attached。
export function restorePet(saved, { windows = [], reattach = true } = {}) {
  const s = normalizePet(saved)
  if (s.mode !== 'attached') return s
  const stillThere = (windows || []).some(
    (w) =>
      String(w && w.hwnd) === s.hwnd &&
      String(w && w.agentId) === s.agentId
  )
  if (stillThere) return s
  return transition(s, { type: 'agent-window-gone' })
}
