// Records example/page.html. Everything here is local to this repository.
//
//   1. start a Chrome with a debugging port:
//        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//          --remote-debugging-port=9222 --user-data-dir=/tmp/cdp-recorder-profile
//   2. node example/record-demo.js
//
// Set CDP_URL if your Chrome is not on http://127.0.0.1:9222.
//
// Writes example/demo.mp4 and prints the report.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { record } from '../src/recorder.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const report = await record({
  url: `file://${path.join(here, 'page.html')}`,
  out: path.join(here, 'demo.mp4'),
  browserURL: process.env.CDP_URL || 'http://127.0.0.1:9222',
  viewport: { width: 1000, height: 640 },
  python: process.env.PYTHON || 'python3',
  steps: [
    { wait: 1200 },
    { scroll: '#scroller', by: 220, times: 6, everyMs: 300, label: 'scroll the list' },
    { wait: 900 },
    { click: '#name', label: 'name field' },
    { fill: '#name', value: 'Ada Lovelace' },
    { wait: 600 },
    { click: '#code', label: 'code field' },
    { fill: '#code', value: 'AL-1843' },
    { wait: 600 },
    { click: '#submit', label: 'save button' },
    { waitFor: `document.querySelector('#result').textContent.length > 0` },
    { wait: 2500 },
  ],
})

console.log(JSON.stringify(report, null, 2))
