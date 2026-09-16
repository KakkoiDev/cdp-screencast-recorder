// A CDP client small enough to read in one sitting.
//
// The transport contract the recorder depends on is two methods, `send` and
// `drainEvents`. It is drain shaped, not listener shaped, because the host this
// recorder was extracted from exposed no CDP event listener at all: the SDK
// object had an `onCDPMessage` property whose value was undefined. Any host
// that can only hand you a batch of buffered events satisfies the same
// contract, so the recorder runs on those hosts unchanged.
//
// Requires Node 22 or newer for the global WebSocket and fetch.

const nextId = (() => {
  let n = 0
  return () => ++n
})()

class Session {
  constructor(ws, sessionId, buffered) {
    this.ws = ws
    this.sessionId = sessionId
    this.buffered = new Set(buffered)
    this.events = []
    this.pending = new Map()
    this.closed = null
    ws.addEventListener('message', (m) => this.#onMessage(m))
    ws.addEventListener('close', () => this.#onClose(new Error('the CDP socket closed')))
    ws.addEventListener('error', () => this.#onClose(new Error('the CDP socket errored')))
  }

  #onMessage(m) {
    const msg = JSON.parse(m.data)
    if (msg.id != null) {
      const slot = this.pending.get(msg.id)
      if (!slot) return
      this.pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(`${slot.method}: ${msg.error.message}`))
      else slot.resolve(msg.result)
      return
    }
    if (this.buffered.has(msg.method)) this.events.push(msg)
  }

  #onClose(err) {
    if (this.closed) return
    this.closed = err
    for (const slot of this.pending.values()) slot.reject(err)
    this.pending.clear()
  }

  // Page level command, routed to the attached target.
  send(method, params = {}) {
    return this.#raw(method, params, this.sessionId)
  }

  // Browser level command, which must not carry a target session id.
  sendBrowser(method, params = {}) {
    return this.#raw(method, params, undefined)
  }

  #raw(method, params, sessionId) {
    if (this.closed) return Promise.reject(this.closed)
    const id = nextId()
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.ws.send(JSON.stringify(payload))
    })
  }

  // Returns every buffered event received since the last call, oldest first.
  drainEvents() {
    const out = this.events
    this.events = []
    return out
  }

  async close({ closeTarget } = {}) {
    if (closeTarget && this.targetId) {
      try {
        await this.sendBrowser('Target.closeTarget', { targetId: this.targetId })
      } catch {
        /* the target is gone, which is the state we wanted */
      }
    }
    this.ws.close()
  }
}

const open = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', () => reject(new Error(`cannot open ${url}`)), { once: true })
  })

/**
 * Attach to a Chrome reachable over CDP.
 *
 * Pass `targetId` to record a page you are already driving. Pass nothing and a
 * fresh page target is created, which the caller owns and should close.
 *
 * @param {object} opts
 * @param {string} [opts.browserURL]  http endpoint, default http://127.0.0.1:9222
 * @param {string} [opts.targetId]    existing page target to attach to
 * @param {string[]} [opts.buffer]    event methods to buffer for drainEvents
 */
export async function attach({
  browserURL = 'http://127.0.0.1:9222',
  targetId,
  buffer = ['Page.screencastFrame'],
} = {}) {
  const res = await fetch(new URL('/json/version', browserURL))
  if (!res.ok) throw new Error(`${browserURL}/json/version answered ${res.status}`)
  const { webSocketDebuggerUrl } = await res.json()
  if (!webSocketDebuggerUrl)
    throw new Error(`${browserURL} is reachable but published no webSocketDebuggerUrl`)

  const ws = await open(webSocketDebuggerUrl)
  const session = new Session(ws, undefined, buffer)

  let created = false
  let id = targetId
  if (!id) {
    ;({ targetId: id } = await session.sendBrowser('Target.createTarget', { url: 'about:blank' }))
    created = true
  }
  const { sessionId } = await session.sendBrowser('Target.attachToTarget', {
    targetId: id,
    flatten: true,
  })
  session.sessionId = sessionId
  session.targetId = id
  session.createdTarget = created
  await session.send('Page.enable')
  return session
}
