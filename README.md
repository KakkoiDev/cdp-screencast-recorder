# cdp-screencast-recorder

Records a Chrome page over the DevTools Protocol as an mp4, with an orange ring
drawn around each element it clicks and an arrow cursor drawn travelling between
the clicks.

It drives the page with CDP input events, collects `Page.screencastFrame`, and
stitches the JPEG frames into an mp4 through an ffmpeg concat list built from
each frame's own capture timestamp. The ring and the cursor are composited onto
the captured frames afterwards, never injected into the page, so the footage is a
record of the page as it actually rendered.

**Read [What the cadence actually is](#what-the-cadence-actually-is) and
[Use Playwright instead](#use-playwright-instead) before you adopt this.** It is
an archive of a technique that worked, not a recommendation.

## What it needs

- **Node 22 or newer.** It uses the global `WebSocket` and `fetch`. No npm
  dependencies.
- **ffmpeg and ffprobe on `PATH`.** The stitch is `ffmpeg -f concat`, and the
  report comes from `ffprobe`.
- **A Python 3 with [Pillow](https://pillow.readthedocs.io/).** `composite.py`
  draws the ring and the cursor. Pass `python` if it is not `python3`.
- **A Chrome reachable over CDP**, that is, started with
  `--remote-debugging-port`.

## How to run it

Start a Chrome with a debugging port:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/cdp-recorder-profile
```

Then record the bundled demo page:

```sh
node example/record-demo.js
```

From your own code, the interface is a URL, a list of steps and an output path.
This is not on npm, so import it from a checkout:

```js
import { record } from './cdp-screencast-recorder/src/recorder.js'

const report = await record({
  url: 'https://example.com/',
  out: 'out.mp4',
  browserURL: 'http://127.0.0.1:9222',
  viewport: { width: 1000, height: 640 },
  steps: [
    { wait: 1000 },
    { click: '#name', label: 'name field' },
    { fill: '#name', value: 'Ada Lovelace' },
    { click: '#submit', label: 'save button' },
    { waitFor: `document.querySelector('#result').textContent.length > 0` },
    { wait: 2500 },
  ],
})
```

Or from a job file:

```sh
node bin/record.js job.json --out out.mp4
```

`record()` returns a report: the mp4 path and size, frames captured and dropped,
wall and span seconds, per step timings, the compositor's own report, and the
`ffprobe` output. Every option, including `cursor`, `cursorStep`, `ringPreMs`,
`ringPostMs`, `quality`, `pollMs`, `python`, `workDir` and `keepFrames`, is
documented on `record()` in [`src/recorder.js`](src/recorder.js).

### Steps

| Step | Effect |
| --- | --- |
| `{ click: sel, label }` | Measures the element once, holds a ring on that rect for `ringPreMs`, dispatches a real mouse click at the centre of **that same rect**, holds the ring for `ringPostMs`. The click point also becomes a cursor anchor. |
| `{ fill: sel, value }` | Focuses the element and inserts text via `Input.insertText`. |
| `{ scroll: sel, by, times, everyMs }` | Dispatches wheel events over the element's centre. The pointer position is recorded as a cursor anchor but draws **no** ring, because no click happened. `sel` may be `null` to scroll at the viewport centre. |
| `{ wait: ms }` | Sleeps. |
| `{ waitFor: expr, timeout }` | Polls `Runtime.evaluate` until the expression is truthy. |
| `{ goto: url, timeout }` | Navigates and waits for `readyState === 'complete'`. |
| `{ eval: js }` | Evaluates an expression and discards the result. |

Pass `targetId` instead of `url` to record a page you are already driving
yourself. The recorder then only captures and composites.

Two invariants are worth knowing, because they are the reason this produces
usable evidence rather than a plausible-looking animation:

- **The ring rect and the click point come from one measurement of one
  element.** A recorder that resolves the selector once for the ring and again
  for the click can ring one element and click another. If the element moves
  while the ring is up, the step fails loudly instead of clicking somewhere the
  ring never covered.
- **Every cursor anchor is a measured point.** The cursor is interpolated
  between real anchors with an ease, and before the first and after the last it
  rests on that anchor rather than being sent along an invented approach path.
  An element with no stable on-screen box gets neither a ring nor an anchor, and
  is named in `ringsSkippedNoStableBox`.

## What the cadence actually is

The screencast only emits a frame when the screen changes, so the capture is
genuinely variable rate: a three second hold is one frame. Two things then act
on that on the way to the mp4.

**1. The concat demuxer quantizes every duration to a 1/25 s grid.** Whatever
duration you write into `concat.txt`, the displayed span in the output is a
multiple of 40 ms. Measured directly, with durations chosen to be off the grid:

| written | 0.37 | 1.53 | 0.12 | 0.09 | 2.04 | 0.443 | 0.66 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| played | 0.36 | 1.56 | 0.12 | 0.08 | 2.04 | 0.44 | 0.64 |

This is a property of the concat path and is not configurable from here.

**2. Drawing a cursor forces frames to be subdivided.** A frame held for
seconds while the pointer travels across it would freeze the pointer, so a span
the cursor moves across is cut on a fixed step (`cursorStep`, default 0.12 s)
and one composited copy is written per piece.

The original version of this code applied that fixed step to **every** frame
whenever a cursor was drawn, and a cursor was always drawn. The result was that
every gap in the output was 40, 80 or 120 ms and nothing else: an effective rate
of about 10 fps, in a tool whose header comment claimed free variable-rate
playback. That comment was wrong, and it is gone.

The subdivision here applies **only where the cursor actually moves**. A span
with the pointer at rest keeps its full duration as a single entry, so long
holds are long frames again.

Measured on one capture of `example/page.html` (22 captured frames, 10.32 s),
stitched three ways from that same capture, with `tools/frame-gaps.sh`:

| gap | fixed step everywhere (before) | motion-only (after, shipped) | `cursor: null` |
| ---: | ---: | ---: | ---: |
| 40 ms | 17 | 16 | 4 |
| 80 ms | 18 | 14 | |
| 120 ms | 68 | 57 | 2 |
| 200 ms | | 1 | 2 |
| 240 ms | | | 2 |
| 280 ms | | 1 | 3 |
| 320 ms | | | 3 |
| 360 ms | | | 1 |
| 400 ms | | | 1 |
| 480 ms | | | 5 |
| 520 ms | | | 1 |
| 1120 ms | | | 1 |
| 1200 ms | | 1 | 2 |
| **concat entries** | **104** | **91** | **27** |
| **duration** | **10.32 s** | **10.32 s** | **10.32 s** |

The before column has exactly three gap values and nothing else. The after
column keeps the long holds: the 2.5 s hold at the end is one 1200 ms frame
plus its neighbours rather than twenty-one identical copies.

The duration is identical in all three columns, so playback speed is unchanged;
the fix only stops manufacturing frames during holds. It does not make the
output free running, because this demo is click-heavy and the cursor is moving
for most of it. The `cursor: null` column is what the capture's own cadence
looks like with nothing added: twelve distinct gaps from 40 ms to 1200 ms.

Re-running the recorder produces a different capture, so your numbers will
differ; the three columns above are one capture stitched three ways, which is
the only comparison that isolates the compositor.

`tools/frame-gaps.sh out.mp4` prints this distribution for any mp4. Use it
rather than a mean frame rate, which hides all of the above.

## Use Playwright instead

For almost everyone, Playwright's built-in
[`recordVideo`](https://playwright.dev/docs/videos) is the better default. It
writes a clean constant-rate stream straight out of the browser, needs no frame
files, no concat list, no ffmpeg on `PATH` and no Python, and none of the cadence
discussion above applies to it. Recording the same `example/page.html` through
the same steps with Playwright 1.63 and `channel: 'chrome'` gives a vp8 webm at
`r_frame_rate=25/1`, 214 frames over 8.56 s, and `tools/frame-gaps.sh` reports
one value: `40 ms x 213`. If you can drive your page with Playwright, record it
with Playwright.

This exists for the case Playwright does not cover: you must record a browser
you are **already** driving over CDP and cannot hand over to Playwright, for
instance a browser owned by another tool or an agent runtime. The other thing
you get here is the drawn ring and cursor, and `composite.py` is usable on its
own against any directory of timestamped frames, whatever captured them.

## Layout

```
src/cdp.js        CDP client; the transport contract is send + drainEvents
src/recorder.js   screencast loop, step driver, stitch
composite.py      ring and cursor compositing, concat list
assets/cursor.png the arrow
bin/record.js     CLI over a job file
example/          a local page and a script that records it
tools/            frame-gaps.sh
```

`src/cdp.js` buffers events and hands them over in batches through
`drainEvents()` rather than exposing a listener. That shape is not an accident:
the host this was extracted from had no CDP event listener at all, so frames
could only be collected by polling. Any polling-only host satisfies the same
contract, and the recorder runs on it unchanged. Each frame is acked with the
`sessionId` it carried, because the stream stalls after a handful of unacked
frames.

## License

MIT. See [LICENSE](LICENSE).
