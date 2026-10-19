// SSE 推送（D028）：daemon → UI 的单向事件流。
//
// 取代 500ms/5s 轮询：首屏拉 /v1/state，之后只收变化。
// 心跳 15s（`: ping`）；慢客户端写失败直接断开，不阻塞其它客户端。

export const HEARTBEAT_MS = 15000
export const MAX_CLIENTS = 16

export function createSseHub({ heartbeatMs = HEARTBEAT_MS } = {}) {
  const clients = new Set()
  let timer = null

  function startHeartbeat() {
    if (timer) return
    timer = setInterval(() => {
      for (const res of clients) write(res, ': ping\n\n')
    }, heartbeatMs)
    timer.unref?.()
  }

  function stopHeartbeat() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  function write(res, chunk) {
    try {
      res.write(chunk)
      return true
    } catch (err) {
      clients.delete(res)
      return false
    }
  }

  return {
    subscribe(req, res) {
      if (clients.size >= MAX_CLIENTS) {
        // 超出上限时踢掉最早的一个，避免慢客户端无限堆积
        const first = clients.values().next().value
        if (first) {
          clients.delete(first)
          try {
            first.end()
          } catch (err) {}
        }
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(': connected\n\n')
      clients.add(res)
      startHeartbeat()
      req.on('close', () => {
        clients.delete(res)
        if (!clients.size) stopHeartbeat()
      })
      return res
    },

    broadcast(event, data) {
      const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data == null ? {} : data) + '\n\n'
      for (const res of [...clients]) {
        if (!write(res, payload)) clients.delete(res)
      }
      if (!clients.size) stopHeartbeat()
    },

    clientCount() {
      return clients.size
    },

    close() {
      stopHeartbeat()
      for (const res of clients) {
        try {
          res.end()
        } catch (err) {}
      }
      clients.clear()
    },
  }
}
