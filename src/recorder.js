// Records a page over CDP as an mp4, with a ring drawn around each click and an
// arrow cursor drawn moving between them.
//
// You give it a URL, a list of steps and an output path. It drives the page
// with CDP input events, collects Page.screencastFrame, and stitches the frames
// into an mp4 through an ffmpeg concat list built from each frame's own capture
// timestamp. The ring and the cursor are composited afterwards by composite.py,
// so nothing is ever injected into the page being recorded.
//
// Read "What the cadence actually is" in the README before believing anything
// about the frame rate of the result.

import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attach } from './cdp.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CURSOR = path.join(HERE, '..', 'assets', 'cursor.png')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${(stderr || err.message).slice(-2000)}`))
      else resolve(stdout)
    })
  })

class Page {
  constructor(session) {
    this.s = session
  }

  async evaluate(expression) {
    const r = await this.s.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails)
      throw new Error(
        `the page threw evaluating ${expression.slice(0, 120)}: ` +
          (r.exceptionDetails.exception?.description || r.exceptionDetails.text),
      )
    return r.result.value
  }

  async waitFor(expression, { timeout = 30000, poll = 100 } = {}) {
    const until = Date.now() + timeout
    for (;;) {
      let v = false
      let last = null
      try {
        v = await this.evaluate(`!!(${expression})`)
      } catch (e) {
        // A page mid navigation throws, so this is a retry. But a broken
        // expression throws every time, and reporting that as a bare timeout
        // sends you looking at the page instead of at your own selector.
        last = e.message
      }
      if (v) return
      if (Date.now() > until)
        throw new Error(
          `waited ${timeout}ms and \`${expression}\` never became true` +
            (last ? `; it last threw: ${last}` : ''),
        )
      await sleep(poll)
    }
  }

  async goto(url, { timeout = 60000 } = {}) {
    await this.s.send('Page.navigate', { url })
    await this.waitFor(`document.readyState === 'complete'`, { timeout })
  }

  // Returns the element's viewport rect in CSS pixels, or a reason it has none.
  box(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return { missing: true }
      const r = el.getBoundingClientRect()
      if (!r || r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight)
        return { unstable: true, why: 'the element had no stable on-screen box' }
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    })()`)
  }

  async mouse(type, x, y, extra = {}) {
    await this.s.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra })
  }

  async clickAt(x, y) {
    await this.mouse('mouseMoved', x, y, { button: 'none' })
    await this.mouse('mousePressed', x, y, { clickCount: 1 })
    await this.mouse('mouseReleased', x, y, { clickCount: 1 })
  }

  async wheelAt(x, y, deltaY) {
    await this.mouse('mouseWheel', x, y, { button: 'none', deltaX: 0, deltaY })
  }

  async fill(selector, value) {
    const box = await this.box(selector)
    if (box.missing) throw new Error(`nothing matched ${selector}`)
    await this.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).focus()`,
    )
    await this.s.send('Input.insertText', { text: value })
  }
}

/**
 * Record a page.
 *
 * @param {object} opts
 * @param {string}   opts.url          page to record; omit when attaching to a target you drive
 * @param {Array}    opts.steps        see README, "Steps"
 * @param {string}   opts.out          output .mp4 path
 * @param {string}   [opts.browserURL] default http://127.0.0.1:9222
 * @param {string}   [opts.targetId]   attach to this existing page target instead of creating one
 * @param {{width:number,height:number,deviceScaleFactor?:number}} [opts.viewport]
 * @param {string}   [opts.workDir]    frame directory, REMOVED AND RECREATED; default <out>.frames
 * @param {number}   [opts.quality]    screencast jpeg quality, default 80
 * @param {string|null} [opts.cursor]  cursor png, or null to draw no cursor
 * @param {number}   [opts.cursorStep] seconds; see README, "What the cadence actually is"
 * @param {number}   [opts.ringPreMs]  ring is held this long before the click
 * @param {number}   [opts.ringPostMs] and this long after it
 * @param {number}   [opts.pollMs]     drainEvents interval, default 100
 * @param {string}   [opts.python]     interpreter that has Pillow, default python3
 * @param {boolean}  [opts.keepFrames] keep the frame directory after stitching
 * @returns {Promise<object>} a report
 */
export async function record({
  url,
  steps = [],
  out,
  browserURL = 'http://127.0.0.1:9222',
  targetId,
  viewport,
  workDir,
  quality = 80,
  cursor = CURSOR,
  cursorStep = 0.12,
  ringPreMs = 1100,
  ringPostMs = 700,
  pollMs = 100,
  python = 'python3',
  keepFrames = false,
}) {
  if (!out) throw new Error('out is required')

  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  } catch {
    throw new Error('ffmpeg is not on PATH, so nothing can be stitched')
  }
  if (cursor) {
    try {
      execFileSync(python, ['-c', 'import PIL'], { stdio: 'ignore' })
    } catch {
      throw new Error(`${python} cannot import Pillow, so the ring and cursor cannot be drawn`)
    }
  }

  const frameDir = workDir || `${out}.frames`
  await fs.rm(frameDir, { recursive: true, force: true })
  await fs.mkdir(frameDir, { recursive: true })
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true })

  const session = await attach({ browserURL, targetId })
  const page = new Page(session)
  let overrodeMetrics = false

  try {
    if (viewport) {
      overrodeMetrics = true
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor || 1,
        mobile: false,
      })
    }
    if (url) await page.goto(url)

    // ------------------------------------------------------------- the pump
    // Frames are collected by draining buffered events rather than by a
    // listener; see the note at the top of cdp.js for why the contract has that
    // shape. Each frame is acked with the sessionId it carried, because the
    // stream stalls after a handful of unacked frames.
    const frames = []
    let dropped = 0
    let stop = false
    const pump = (async () => {
      // Drain before testing `stop`, so the batch buffered at the moment the
      // drive finished is written instead of thrown away with the loop.
      for (;;) {
        for (const ev of session.drainEvents()) {
          if (ev.method !== 'Page.screencastFrame') continue
          const p = ev.params || {}
          if (p.sessionId != null) {
            try {
              await session.send('Page.screencastFrameAck', { sessionId: p.sessionId })
            } catch {
              /* the frame is already captured; a failed ack only costs throughput */
            }
          }
          if (!p.data) {
            dropped++
            continue
          }
          const file = path.join(frameDir, `${String(frames.length).padStart(6, '0')}.jpg`)
          await fs.writeFile(file, Buffer.from(p.data, 'base64'))
          frames.push({
            file,
            // metadata.timestamp is seconds since epoch as a float, and is the
            // frame's own capture time, which is what the stitch needs.
            t: p.metadata?.timestamp || Date.now() / 1000,
          })
        }
        if (stop) return
        await sleep(pollMs)
      }
    })()

    await session.send('Page.startScreencast', { format: 'jpeg', quality, everyNthFrame: 1 })
    const started = Date.now()

    // ------------------------------------------------------------- the drive
    // The ring rect and the cursor anchor come from ONE measurement of ONE
    // element, and the click is dispatched at the centre of that same rect. A
    // recorder that resolves the element twice can ring one element and click
    // another, which is a video that lies about what happened.
    const rings = []
    const clicks = []
    const log = []

    const clickWithRing = async (selector, label) => {
      const box = await page.box(selector)
      if (box.missing) throw new Error(`nothing matched ${selector}`)
      const t0 = Date.now() / 1000
      if (box.unstable) {
        // No approximate ring, and no invented cursor anchor either. The step
        // is recorded without both and named in the report.
        rings.push({ label, unstable: true, why: box.why, t0, t1: t0 })
        return
      }
      // The ring goes up before the click and is held through it, so the viewer
      // sees what is about to be clicked, not a flash after the fact.
      await sleep(ringPreMs)
      const now = await page.box(selector)
      const moved =
        now.missing ||
        now.unstable ||
        ['x', 'y', 'w', 'h'].some((k) => Math.abs(now[k] - box[k]) > 2)
      if (moved)
        throw new Error(
          `${selector} moved or resized while the ring was up, so the ring and the click would be on different rects`,
        )
      const cx = box.x + box.w / 2
      const cy = box.y + box.h / 2
      const tClick = Date.now() / 1000
      await page.clickAt(cx, cy)
      await sleep(ringPostMs)
      rings.push({ ...box, label, t0, t1: Date.now() / 1000 })
      clicks.push({ t: tClick, x: cx, y: cy, label, kind: 'click' })
    }

    const runStep = async (s) => {
      if (s.wait != null) return sleep(s.wait)
      if (s.goto) return page.goto(s.goto, { timeout: s.timeout })
      if (s.waitFor) return page.waitFor(s.waitFor, { timeout: s.timeout ?? 30000 })
      if (s.eval) return void (await page.evaluate(s.eval))
      if (s.click) return clickWithRing(s.click, s.label || s.click)
      if (s.fill) {
        await page.fill(s.fill, s.value ?? '')
        return
      }
      if (s.scroll !== undefined) {
        const box = s.scroll ? await page.box(s.scroll) : null
        if (box?.missing) throw new Error(`nothing matched ${s.scroll}`)
        const x = box && !box.unstable ? box.x + box.w / 2 : (viewport?.width ?? 800) / 2
        const y = box && !box.unstable ? box.y + box.h / 2 : (viewport?.height ?? 600) / 2
        // The pointer has to be over the area being scrolled for a wheel to
        // reach it, so this is a real pointer position. It is logged as a
        // pointer anchor, never as a click: no ring is drawn for it.
        clicks.push({ t: Date.now() / 1000, x, y, label: s.label || 'scroll', kind: 'pointer' })
        const times = s.times ?? 1
        for (let i = 0; i < times; i++) {
          await page.wheelAt(x, y, s.by ?? 300)
          await sleep(s.everyMs ?? 250)
        }
        return
      }
      throw new Error(`unrecognised step: ${JSON.stringify(s)}`)
    }

    let driveError = null
    try {
      for (const s of steps) {
        const t = Date.now()
        await runStep(s)
        log.push({ step: s.label || Object.keys(s)[0], ms: Date.now() - t })
      }
    } catch (e) {
      driveError = e.message
    }

    await session.send('Page.stopScreencast', {})
    stop = true
    await pump
    const wall = (Date.now() - started) / 1000

    if (driveError)
      throw new Error(
        `the drive failed after ${frames.length} frames in ${wall}s, so there is nothing worth stitching: ${driveError}`,
      )
    if (frames.length < 2)
      throw new Error(`only ${frames.length} frames arrived in ${wall}s (${dropped} dropped or empty)`)

    // ------------------------------------------------------------- the stitch
    const vp = await page.evaluate(`JSON.stringify({ w: innerWidth, h: innerHeight })`)
    await fs.writeFile(
      path.join(frameDir, 'capture.json'),
      JSON.stringify({
        frames,
        rings,
        clicks,
        viewport: JSON.parse(vp),
        cursor: cursor ? path.resolve(cursor) : null,
        cursorStep,
      }),
    )

    const composite = JSON.parse(
      await run(python, [path.join(HERE, '..', 'composite.py'), frameDir]),
    )

    await run('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', path.join(frameDir, 'concat.txt'),
      '-fps_mode', 'vfr',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
      out,
    ])

    const stat = await fs.stat(out)
    const probe = JSON.parse(
      await run('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-count_frames',
        '-show_entries', 'stream=nb_read_frames,width,height,avg_frame_rate',
        '-show_entries', 'format=duration',
        '-of', 'json',
        out,
      ]),
    )

    if (!keepFrames) await fs.rm(frameDir, { recursive: true, force: true })

    return {
      mp4: path.resolve(out),
      bytes: stat.size,
      framesCaptured: frames.length,
      framesDroppedOrEmpty: dropped,
      wallSeconds: Number(wall.toFixed(2)),
      spanSeconds: Number((frames[frames.length - 1].t - frames[0].t).toFixed(2)),
      steps: log,
      composite,
      probe,
    }
  } finally {
    // A target the caller owns goes back the size we found it.
    if (overrodeMetrics && !session.createdTarget) {
      try {
        await session.send('Emulation.clearDeviceMetricsOverride')
      } catch {
        /* the target is already gone, which clears it too */
      }
    }
    await session.close({ closeTarget: session.createdTarget })
  }
}
