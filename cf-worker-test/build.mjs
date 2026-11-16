#!/usr/bin/env node
/**
 * 把 frontend/fetch-wrap.js 嵌入 worker.js 的 FETCH_WRAP_IIFE。
 * 产物仍是单文件 worker.js，供 Cloudflare dashboard 粘贴。
 *
 *   node cf-worker-test/build.mjs
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BEGIN = '/* <FETCH_WRAP_IIFE_BEGIN> */'
const END = '/* <FETCH_WRAP_IIFE_END> */'

const root = dirname(fileURLToPath(import.meta.url))
const wrapSrc = readFileSync(join(root, 'frontend/fetch-wrap.js'), 'utf8')
const workerPath = join(root, 'worker.js')
const workerSrc = readFileSync(workerPath, 'utf8')

const inner = wrapSrc.replace(/^export /gm, '')
const iife = [
  '// <JSPROXY_YT_TEST_FETCH_WRAP>',
  '(function(){',
  inner.trimEnd(),
  'installJsproxyYtTestFetchWrap(self);',
  '})();',
  '// </JSPROXY_YT_TEST_FETCH_WRAP>',
].join('\n')

const block = [
  BEGIN,
  'var FETCH_WRAP_IIFE = ' + JSON.stringify(iife),
  END,
].join('\n')

let next
if (workerSrc.includes(BEGIN) && workerSrc.includes(END)) {
  next = workerSrc.replace(
    /\/\* <FETCH_WRAP_IIFE_BEGIN> \*\/[\s\S]*?\/\* <FETCH_WRAP_IIFE_END> \*\//,
    block
  )
} else if (/var FETCH_WRAP_IIFE = /.test(workerSrc)) {
  next = workerSrc.replace(/var FETCH_WRAP_IIFE = [\s\S]*?\n(?=\nfunction swScript)/, block + '\n')
} else {
  throw new Error('worker.js missing FETCH_WRAP_IIFE assignment')
}

if (next === workerSrc) {
  const already = workerSrc.includes(JSON.stringify(iife))
  if (!already) throw new Error('failed to replace FETCH_WRAP_IIFE in worker.js')
}

writeFileSync(workerPath, next)
try {
  copyFileSync(workerPath, join(root, 'offline-harness', 'worker.js'))
} catch (err) {
  process.stderr.write('note: could not copy worker.js to offline-harness: ' + err + '\n')
}
process.stdout.write('embedded fetch-wrap.js -> worker.js FETCH_WRAP_IIFE (' + iife.length + ' chars)\n')
