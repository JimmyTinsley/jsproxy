#!/usr/bin/env node
/**
 * 自包含离线回归：Worker + 合成上游 + 浏览器页面。
 * 不请求真实 Google 登录、sorry、签名媒体。
 *
 *   node server.mjs
 *   node server.mjs --self-test
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const workerPath = existsSync(join(here, 'worker.js'))
  ? join(here, 'worker.js')
  : join(here, '..', 'worker.js')
const workerSrc = readFileSync(workerPath, 'utf8')
const PORT = Number(process.env.PORT || 8793)

const ALLOWED_SUFFIXES = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'ytimg.com',
  'googlevideo.com',
  'ggpht.com',
  'googleusercontent.com',
  'gstatic.com',
  'googleapis.com',
  'google.com',
  'wide-youtube.l.google.com',
]

function hostAllowed(host) {
  host = String(host || '').toLowerCase()
  return ALLOWED_SUFFIXES.some((d) => host === d || host.endsWith('.' + d))
}

function mockUpstream(urlObj, init) {
  const headersIn = new Headers((init && init.headers) || undefined)
  const echo = {
    synthetic: true,
    href: urlObj.href,
    host: urlObj.host,
    pathname: urlObj.pathname,
    continue: urlObj.searchParams.get('continue'),
    origin: headersIn.get('origin'),
    cookie: headersIn.get('cookie'),
    ua: headersIn.get('user-agent'),
    secFetchSite: headersIn.get('sec-fetch-site'),
  }
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' })
  headers.append(
    'set-cookie',
    'SID=syn.sid; Domain=.google.com; Path=/; Secure; HttpOnly; Expires=Wed, 21 Oct 2030 07:28:00 GMT'
  )
  headers.append('set-cookie', 'HSID=syn.hsid; Domain=.google.com; Path=/; Secure; HttpOnly')
  headers.append('set-cookie', '__Host-GAPS=syn.gaps; Path=/; Secure; HttpOnly')
  return new Response(JSON.stringify(echo), { status: 200, headers })
}

function loadWorker() {
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    ReadableStream,
    Uint8Array,
    Map,
    Object,
    JSON,
    String,
    Array,
    Date,
    Error,
    TypeError,
    fetch(input, init) {
      const url = typeof input === 'string' ? input : input && input.url
      const u = new URL(url)
      if (u.hostname === 'etherdream.github.io') return globalThis.fetch(input, init)
      if (hostAllowed(u.hostname)) return Promise.resolve(mockUpstream(u, init))
      return globalThis.fetch(input, init)
    },
    addEventListener() {},
    self: null,
  }
  sandbox.self = sandbox
  vm.createContext(sandbox)
  vm.runInContext(workerSrc, sandbox, { filename: 'worker.js' })
  if (!sandbox.__JSPROXY_YT_TEST__) throw new Error('worker.js missing __JSPROXY_YT_TEST__')
  return sandbox.__JSPROXY_YT_TEST__
}

const PAGE = `<!doctype html>
<meta charset=utf-8>
<title>jsproxy-yt-test v123 离线回归</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:52em;margin:1.5em auto;padding:0 1em;line-height:1.45}
.warn{background:#fff3cd;border:1px solid #c9a227;padding:1em}
.ok{color:#0a7a28;font-weight:700} .bad{color:#b00020;font-weight:700}
pre{background:#f6f8fa;padding:1em;overflow:auto;font-size:12px}
table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:.4em .6em;text-align:left}
</style>
<div class=warn>
  <strong>隔离测试，不是生产 js.jimmytinsley.com。</strong>
  本页只用合成无秘密数据。不登录、不读真实 Cookie、不打开 Google 401/sorry。
  修 Cookie/头 ≠ 过 YouTube 人机门，也不能承诺能播。
</div>
<p>Worker <code id=ver>?</code> · 把下面结果整页复制发回即可。无需 clone 仓库。</p>
<p id=summary>正在跑…</p>
<table id=rows></table>
<pre id=raw></pre>
<script>
(async () => {
  const rows = document.getElementById('rows')
  const results = []
  function add(name, pass, detail) {
    results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail).slice(0, 300) })
    const tr = document.createElement('tr')
    tr.innerHTML = '<td>' + (pass ? '<span class=ok>PASS</span>' : '<span class=bad>FAIL</span>') +
      '</td><td>' + name + '</td><td><code>' + String(detail || '').replace(/</g,'&lt;').slice(0, 240) + '</code></td>'
    rows.appendChild(tr)
  }
  try {
    const info = await (await fetch('/__test__/info', { cache: 'no-store' })).json()
    document.getElementById('ver').textContent = info.testVer + ' / ' + info.tag
    add('info testVer 123', info.testVer === '123', info.testVer)
    add('info isolated', info.isolatedTest === true && info.playbackNotGuaranteed === true)
    add('info numbered cookies', info.multiCookieNumbered === true)
    add('info reqmap header', info.reqmapHeader === 'x-jsproxy-reqmap')
    add('info bot-gate independent', info.botGateIndependent === true)

    const compat = await (await fetch('/__test__/compat', { cache: 'no-store' })).json()
    add('compat.pass', compat.pass === true, JSON.stringify({
      v122Lost: compat.v122LostCookies,
      v123Kept: compat.v123KeptAllCookies,
      origin: compat.restoredOrigin,
      continueHost: compat.continueHost,
      ua: compat.restoredUa
    }))
    add('v122 lost cookies (baseline)', compat.v122LostCookies === true, (compat.v122CookieNames || []).join(','))
    add('v123 kept SID/HSID/GAPS', compat.v123KeptAllCookies && compat.gapsKept, (compat.v123CookieNames || []).join(','))
    add('Expires comma intact', compat.expiresCommaIntact === true)
    add('Origin from map is youtube.com, not proxy', compat.restoredOrigin === 'https://www.youtube.com' && !compat.leakedWorkerOrigin)
    add('long cookie via x-jsproxy-reqmap', compat.restoredCookieHasSyn === true)
    add('UA passthrough (not synthesized Chrome)', /jsproxy-yt-test-synthetic/.test(compat.restoredUa || ''))
    add('hop sec-fetch/cf stripped', compat.leakedSecFetch == null && compat.leakedCf == null)
    add('continue host stays www.youtube.com', compat.continueIsYoutube === true, compat.continueHost)

    const packed = new URLSearchParams({
      origin: 'https://www.youtube.com',
      cookie: 'SYN=' + 'x'.repeat(4500),
      referer: 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
    }).toString()
    const login = await fetch('/http/https://accounts.google.com/ServiceLogin?continue=' + encodeURIComponent('https://www.youtube.com/watch?v=jNQXAC9IVRw'), {
      cache: 'no-store',
      referrer: '/?' + packed,
      headers: { 'x-jsproxy-reqmap': packed }
    })
    add('synthetic ServiceLogin status 200 (mock, not Google)', login.status === 200, String(login.status))
    const names = []
    for (const [k, v] of login.headers.entries()) {
      if (/set-cookie/.test(k)) names.push(k + '=' + String(v).split(';')[0])
    }
    add('response has numbered set-cookie headers', names.length >= 3 || login.headers.get('1-set-cookie'), names.join(' | '))
    let echo = {}
    try { echo = await login.json() } catch (e) { echo = { parseError: String(e) } }
    add('mock origin got youtube Origin', echo.origin === 'https://www.youtube.com', echo.origin)
    add('mock origin got long SYN cookie', typeof echo.cookie === 'string' && echo.cookie.length > 4000, echo.cookie ? echo.cookie.length : echo.cookie)
    add('mock origin continue is youtube', typeof echo.continue === 'string' && echo.continue.indexOf('www.youtube.com') >= 0, echo.continue)
    add('mock origin no sec-fetch-site hop leak', echo.secFetchSite == null, echo.secFetchSite)

    const denied = await fetch('/http/https://example.com/', { cache: 'no-store' })
    add('example.com still 403', denied.status === 403)

    const refInit = { referrer: '/?' + packed, cache: 'no-store' }
    const refProbe = await fetch('/__test__/sink?k=referrer-probe', Object.assign({ method: 'POST', body: 'probe' }, refInit))
    add('sink still 200 with long referrer init', refProbe.status === 200, String(refProbe.status))
  } catch (err) {
    add('page threw', false, err && (err.stack || err.message) || err)
  }
  const failed = results.filter(r => !r.pass)
  document.getElementById('summary').innerHTML = failed.length
    ? '<span class=bad>FAILED ' + failed.length + '</span>'
    : '<span class=ok>ALL PASSED</span>'
  document.getElementById('raw').textContent = JSON.stringify({
    when: new Date().toISOString(),
    href: location.href,
    failed: failed.length,
    results
  }, null, 2)
})()
</script>
`

const api = loadWorker()

async function selfTest() {
  const origin = 'http://127.0.0.1:' + PORT
  const info = await api.handleRequest(new Request(origin + '/__test__/info'))
  const infoJson = await info.json()
  const compat = await api.handleRequest(new Request(origin + '/__test__/compat'))
  const compatJson = await compat.json()
  if (infoJson.testVer !== '123' || !compatJson.pass) {
    console.error('SELF-TEST FAIL', { testVer: infoJson.testVer, compat: compatJson })
    process.exit(1)
  }
  console.log('SELF-TEST PASS', { testVer: infoJson.testVer, cookies: compatJson.v123CookieNames })
}

if (process.argv.includes('--self-test')) {
  await selfTest()
  process.exit(0)
}

const server = createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, 'http://127.0.0.1:' + PORT)
    if (parsed.pathname === '/' || parsed.pathname === '/index.html' || parsed.pathname === '/offline.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(PAGE)
      return
    }
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue
      if (k === 'host' || k === 'connection' || k === 'content-length' || k === 'transfer-encoding') continue
      headers.set(k, Array.isArray(v) ? v.join(', ') : v)
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    const buf = Buffer.concat(chunks)
    const init = { method: req.method, headers }
    if (buf.length) init.body = buf
    const request = new Request('http://127.0.0.1:' + PORT + req.url, init)
    const response = await api.handleRequest(request)
    const outHdrs = {}
    response.headers.forEach((v, k) => {
      outHdrs[k] = v
    })
    const outBuf = Buffer.from(await response.arrayBuffer())
    res.writeHead(response.status, outHdrs)
    res.end(outBuf)
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(String((err && err.stack) || err))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('jsproxy-yt-test v123 offline harness\n')
  process.stdout.write('worker: ' + workerPath + '\n')
  process.stdout.write('open  http://127.0.0.1:' + PORT + '/\n')
  process.stdout.write('synthetic origin only; no Google login; no sorry; no signed media\n')
})
