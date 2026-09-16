#!/usr/bin/env node
// Records a page from a job file.
//
//   node bin/record.js job.json [--browser-url http://127.0.0.1:9222] [--out out.mp4]
//
// The job file is the options object documented on record() in src/recorder.js,
// at minimum { "url": ..., "out": ..., "steps": [...] }.
import fs from 'node:fs/promises'
import { record } from '../src/recorder.js'

const argv = process.argv.slice(2)
const jobPath = argv.find((a) => !a.startsWith('--'))
if (!jobPath) {
  console.error('usage: record.js <job.json> [--browser-url URL] [--out FILE] [--python BIN]')
  process.exit(2)
}

const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}

const job = JSON.parse(await fs.readFile(jobPath, 'utf8'))
const opts = {
  ...job,
  ...(flag('browser-url') ? { browserURL: flag('browser-url') } : {}),
  ...(flag('out') ? { out: flag('out') } : {}),
  ...(flag('python') ? { python: flag('python') } : {}),
  ...(argv.includes('--keep-frames') ? { keepFrames: true } : {}),
}

try {
  console.log(JSON.stringify(await record(opts), null, 2))
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
