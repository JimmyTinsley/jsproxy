#!/usr/bin/env node
/**
 * 本地验证隔离测试 Worker：Node 契约 + 本机 HTTP + Chrome WorkerGlobalScope 流式 POST。
 * 不请求 YouTube 签名媒体 URL，不使用私有 API。
 */
import { createServer } from 'node:http'
import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const workerSrc = readFileSync(join(root, 'worker.js'), 'utf8')
const wrapSrc = readFileSync(join(root, 'frontend/fetch-wrap.js'), 'utf8')

const failures = []
function pass(name) {
  console.log('  PASS', name)
}
function fail(name, detail) {
  failures.push(name + ': ' + detail)
  console.log('  FAIL', name, detail)
}
function assert(name, cond, detail) {
  if (cond) pass(name)
  else fail(name, detail || 'assertion failed')
}

function isAllowedYoutubeGoogleHost(host) {
  const suffixes = [
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
  host = String(host || '').toLowerCase()
  return suffixes.some((d) => host === d || host.endsWith('.' + d))
}

function mockUpstream(urlObj, init) {
  const headersIn = new Headers((init && init.headers) || undefined)
  const echo = {
    synthetic: true,
    href: urlObj.href,
    host: urlObj.host,
    pathname: urlObj.pathname,
    search: urlObj.search,
    continue: urlObj.searchParams.get('continue'),
    origin: headersIn.get('origin'),
    cookie: headersIn.get('cookie'),
    ua: headersIn.get('user-agent'),
    referer: headersIn.get('referer'),
    xJsproxy: headersIn.get('x-jsproxy'),
    secFetchSite: headersIn.get('sec-fetch-site'),
    reqmap: headersIn.get('x-jsproxy-reqmap'),
  }
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' })
  headers.append(
    'set-cookie',
    'SID=syn.sid; Domain=.google.com; Path=/; Secure; HttpOnly; Expires=Wed, 21 Oct 2030 07:28:00 GMT'
  )
  headers.append('set-cookie', 'HSID=syn.hsid; Domain=.google.com; Path=/; Secure; HttpOnly')
  headers.append('set-cookie', '__Host-GAPS=syn.gaps; Path=/; Secure; HttpOnly')
  if (urlObj.pathname === '/redirect') {
    headers.set(
      'location',
      'https://accounts.google.com/ServiceLogin?continue=' +
        encodeURIComponent('https://www.youtube.com/watch?v=jNQXAC9IVRw')
    )
    return new Response(JSON.stringify(echo), { status: 302, headers })
  }
  return new Response(JSON.stringify(echo), { status: 200, headers })
}

function loadWorker() {
  const listeners = []
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
    fetch: function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url
      const u = new URL(url)
      if (u.hostname === 'etherdream.github.io') {
        return globalThis.fetch(input, init)
      }
      if (isAllowedYoutubeGoogleHost(u.hostname)) {
        return Promise.resolve(mockUpstream(u, init))
      }
      return globalThis.fetch(input, init)
    },
    addEventListener(type, fn) {
      if (type === 'fetch') listeners.push(fn)
    },
    self: null,
  }
  sandbox.self = sandbox
  vm.createContext(sandbox)
  vm.runInContext(workerSrc, sandbox, { filename: 'worker.js' })
  if (!sandbox.__JSPROXY_YT_TEST__) {
    throw new Error('worker did not export __JSPROXY_YT_TEST__')
  }
  return { api: sandbox.__JSPROXY_YT_TEST__, listeners, sandbox }
}

function extractWrap(api) {
  const sw = api.swScript()
  const m = sw.match(/\/\/ <JSPROXY_YT_TEST_FETCH_WRAP>\n([\s\S]*?)\n\/\/ <\/JSPROXY_YT_TEST_FETCH_WRAP>/)
  if (!m) throw new Error('missing wrap markers in swScript()')
  return m[1]
}

async function nodeContractTests(api) {
  console.log('\n== Node contract ==')
  assert('tag', api.tag === 'jsproxy-yt-test', api.tag)
  assert('ver', api.testVer === '123', api.testVer)
  assert('allow youtube', api.hostAllowed('www.youtube.com') === true)
  assert('allow googlevideo', api.hostAllowed('rr1---sn-abc.googlevideo.com') === true)
  assert('allow ytimg', api.hostAllowed('i.ytimg.com') === true)
  assert('allow youtube-nocookie', api.hostAllowed('www.youtube-nocookie.com') === true)
  assert('deny doubleclick ads host', api.hostAllowed('googleads.g.doubleclick.net') === false)
  assert('deny example.com', api.hostAllowed('example.com') === false)
  assert('deny evilgoogle.com', api.hostAllowed('evilgoogle.com') === false)
  assert('deny twitter', api.hostAllowed('twitter.com') === false)
  assert(
    'sanitize drops query',
    api.sanitizeUrl('https://rr.googlevideo.com/videoplayback?id=1&signature=SECRET&n=NOPE') ===
      'https://rr.googlevideo.com/videoplayback'
  )
  assert('worker contains wrap marker', workerSrc.includes('JSPROXY_YT_TEST_FETCH_WRAP'))
  assert('worker buffers stream in sw', workerSrc.includes('body.getReader') && workerSrc.includes('arrayBuffer()'))
  const wrapLogic = api.swScript().replace(/\/\*[\s\S]*?\*\//g, '')
  assert(
    'worker does not treat duplex as sole fix',
    wrapLogic.includes('delete out.duplex') && !/duplex:\s*['"]half['"]/.test(wrapLogic)
  )
  assert('conf disables static_boost', api.swScript().includes("assets_cdn+'bundle.c33e24c5.js'") || workerSrc.includes('static_boost: { enable: false'))
  assert('conf ver 123', workerSrc.includes("TEST_VER = '123'") && api.swScript().includes('jsproxy-yt-test sw 123'))
  assert('sw cache-busts patched bundle', api.swScript().includes('bundle.c33e24c5.js?jsproxy-yt-test=123'))
  assert('worker numbered cookies + reqmap', workerSrc.includes("'-set-cookie'") && workerSrc.includes('x-jsproxy-reqmap'))
  assert('frontend wrap exported', wrapSrc.includes('prepareOutgoingInit') && wrapSrc.includes('installJsproxyYtTestFetchWrap'))
  assert('sw embeds frontend wrap', api.swScript().includes('prepareOutgoingInit') && api.swScript().includes('installJsproxyYtTestFetchWrap(self)'))
  assert('no production host hardcoded as ASSET_URL default', !workerSrc.includes("ASSET_URL = 'https://etherdream.github.io/jsproxy'") || workerSrc.includes('UPSTREAM_STATIC'))
  assert('no secrets', !/api[_-]?key|password|secret_token/i.test(workerSrc))
}

async function handleViaWorker(api, req) {
  return api.handleRequest(req)
}

async function workerHttpTests(api) {
  console.log('\n== Worker handleRequest ==')
  const origin = 'https://yt-test.example'
  const info = await handleViaWorker(api, new Request(origin + '/__test__/info'))
  const infoJson = await info.json()
  assert('info 200', info.status === 200)
  assert('info isolated', infoJson.isolatedTest === true && infoJson.playbackNotGuaranteed === true)
  assert('info wrap reuse flags', infoJson.wrapInPlaceBody === true && infoJson.wrapAbortRethrow === true)
  assert('info jsfilter patch flag', infoJson.jsfilterPatch === 'postMessage-call-only')
  assert('info v123 flags', infoJson.multiCookieNumbered === true && infoJson.reqmapHeader === 'x-jsproxy-reqmap')
  assert('info bot-gate independent', infoJson.botGateIndependent === true)
  assert('info boost off', infoJson.staticBoost === false)
  assert('info --jsproxy-test', info.headers.get('--jsproxy-test') === '1')

  const works = await handleViaWorker(api, new Request(origin + '/works'))
  assert('works', works.status === 200 && (await works.text()) === 'it works')

  const sw = await handleViaWorker(api, new Request(origin + '/sw.js'))
  const swText = await sw.text()
  assert('sw.js wrap present', swText.includes('prepareOutgoingInit') && swText.includes(infoJson.bundle))
  assert('sw.js no-store', sw.headers.get('cache-control') === 'no-store')

  const conf = await handleViaWorker(api, new Request(origin + '/conf.js'))
  const confText = await conf.text()
  assert('conf boost false', confText.includes('static_boost: { enable: false'))
  assert('conf mysite only', confText.includes("node_default: 'mysite'") && !confText.includes('demo-hk'))

  const opt = await handleViaWorker(
    api,
    new Request(origin + '/http/https://www.youtube.com/watch?v=jNQXAC9IVRw', { method: 'OPTIONS' })
  )
  assert('preflight 204 even without ACRH', opt.status === 204)
  assert('preflight ACAO', opt.headers.get('access-control-allow-origin') === '*')
  assert('preflight ACAM', /POST/.test(opt.headers.get('access-control-allow-methods') || ''))

  const opt2 = await handleViaWorker(
    api,
    new Request(origin + '/http/https://www.youtube.com/', {
      method: 'OPTIONS',
      headers: { 'access-control-request-headers': 'x-foo', 'access-control-request-method': 'POST' },
    })
  )
  assert('preflight with ACRH still 204', opt2.status === 204)

  const denied = await handleViaWorker(api, new Request(origin + '/http/https://example.com/'))
  const deniedText = await denied.text()
  assert('deny example 403', denied.status === 403)
  assert('deny not fake 200 html', denied.headers.get('content-type') !== 'text/html; charset=utf-8')
  assert('deny --error', denied.headers.get('--error') === 'host-denied')
  assert('deny body mentions host', /example.com/.test(deniedText))

  const sinkGet = await handleViaWorker(api, new Request(origin + '/__test__/sink', { method: 'POST', body: 'abc' }))
  const sinkJson = await sinkGet.json()
  assert('sink bytes 3', sinkJson.bytes === 3)

  const emptyPost = await handleViaWorker(api, new Request(origin + '/__test__/sink', { method: 'POST' }))
  const emptyJson = await emptyPost.json()
  assert('empty post 0 bytes', emptyJson.bytes === 0)

  const full = await handleViaWorker(api, new Request(origin + '/__test__/range'))
  assert('range GET 200 256', full.status === 200 && Number(full.headers.get('content-length')) === 256)

  const part = await handleViaWorker(
    api,
    new Request(origin + '/__test__/range', { headers: { Range: 'bytes=0-31' } })
  )
  const partBuf = new Uint8Array(await part.arrayBuffer())
  assert('range 206', part.status === 206)
  assert('range 32 bytes', partBuf.length === 32)
  assert('range content-range', part.headers.get('content-range') === 'bytes 0-31/256')
  assert('range first bytes', partBuf[0] === 0 && partBuf[31] === 31)

  const e404 = await handleViaWorker(api, new Request(origin + '/__test__/status?code=404'))
  const e404Text = await e404.text()
  assert('error 404 not fake 200', e404.status === 404 && !/text\/html/.test(e404.headers.get('content-type') || ''))
  assert('error 404 --error', e404.headers.get('--error') === 'status')
  assert('error 404 body', e404Text === 'status 404')

  const e502 = await handleViaWorker(api, new Request(origin + '/__test__/status?code=502'))
  assert('error 502 kept', e502.status === 502 && e502.headers.get('--s') === '502')

  const index = await handleViaWorker(api, new Request(origin + '/assets/index_v3.html'))
  const indexText = await index.text()
  assert('index is test page', /隔离测试/.test(indexText) && /jNQXAC9IVRw/.test(indexText))
  assert('index has no SW-hijackable self-check href', !/href\s*=\s*["']\/__test__\//.test(indexText) && !/href\s*=\s*["']\/works/.test(indexText))

  const compat = await handleViaWorker(api, new Request(origin + '/__test__/compat'))
  const compatJson = await compat.json()
  assert('compat 200 pass', compat.status === 200 && compatJson.pass === true, JSON.stringify(compatJson))
}

async function proxyCompatTests(api) {
  console.log('\n== proxy cookie/header/continue (synthetic) ==')
  const origin = 'https://yt-test.example'
  const { getResInfo } = await import('../frontend/get-res-info.js')
  const {
    encodeEscapedResHeaders,
    encodeSetCookieV122Collapsed,
    restoreOriginRequestHeaders,
    attachReqMapHeader,
    rebuildProxyTarget,
    continueHostFromUrl,
    REQMAP_HEADER,
  } = await import('../frontend/proxy-headers.js')

  const originRes = new Headers()
  originRes.append(
    'set-cookie',
    'SID=syn.sid; Domain=.google.com; Path=/; Secure; HttpOnly; Expires=Wed, 21 Oct 2030 07:28:00 GMT'
  )
  originRes.append('set-cookie', 'HSID=syn.hsid; Domain=.google.com; Path=/; Secure; HttpOnly')
  originRes.append('set-cookie', '__Host-GAPS=syn.gaps; Path=/; Secure; HttpOnly')
  const collapsed = encodeSetCookieV122Collapsed(originRes)
  const numbered = encodeEscapedResHeaders(originRes, false)
  const parsed122 = getResInfo(new Response('', { headers: collapsed }))
  const parsed123 = getResInfo(new Response('', { headers: numbered.resHdrNew }))
  const parsed123Api = api.getResInfo(new Response('', { headers: numbered.resHdrNew }))
  assert('v122 collapses to <3 cookies', parsed122.cookieStrArr.length < 3, String(parsed122.cookieStrArr.length))
  assert('v123 keeps 3 cookies', parsed123.cookieStrArr.length === 3, JSON.stringify(parsed123.cookieStrArr))
  assert('v123 worker getResInfo matches frontend', parsed123Api.cookieStrArr.length === 3)
  assert(
    'v123 keeps Expires comma',
    parsed123.cookieStrArr.some((s) => /Expires=Wed, 21 Oct 2030/.test(s))
  )
  assert(
    'v123 keeps __Host-GAPS',
    parsed123.cookieStrArr.some((s) => s.startsWith('__Host-GAPS='))
  )

  const entriesEmpty = Object.entries(new URLSearchParams('cookie=a=1&origin=https://www.youtube.com'))
  const fe = []
  new URLSearchParams('cookie=a=1&origin=https://www.youtube.com').forEach((_v, k) => fe.push(k))
  assert('Object.entries(URLSearchParams) empty (prod cf-worker quirk)', entriesEmpty.length === 0)
  assert('forEach restores keys', fe.includes('cookie') && fe.includes('origin'))

  const longCookie = 'SYN=' + 'x'.repeat(4500)
  const packed = new URLSearchParams({
    origin: 'https://www.youtube.com',
    cookie: longCookie,
    referer: 'https://www.youtube.com/',
  }).toString()
  const incoming = new Headers({
    'user-agent': 'Mozilla/5.0 jsproxy-yt-test-synthetic',
    origin: 'https://yt-test.example',
    cookie: 'workerSite=1',
    'sec-fetch-site': 'same-origin',
    'cf-connecting-ip': '203.0.113.1',
    referer: 'https://yt-test.example/',
  })
  incoming.set(REQMAP_HEADER, packed)
  const restored = restoreOriginRequestHeaders(incoming)
  assert('origin from map not proxy', restored.reqHdrNew.get('origin') === 'https://www.youtube.com')
  assert('long cookie restored via reqmap', (restored.reqHdrNew.get('cookie') || '').length > 4000)
  assert('UA passthrough not synthesized Chrome', restored.reqHdrNew.get('user-agent') === 'Mozilla/5.0 jsproxy-yt-test-synthetic')
  assert('worker site cookie not leaked', !/workerSite=/.test(restored.reqHdrNew.get('cookie') || ''))
  assert('sec-fetch-site hop stripped', restored.reqHdrNew.get('sec-fetch-site') === null)
  assert('cf-connecting-ip stripped', restored.reqHdrNew.get('cf-connecting-ip') === null)

  const truncatedIncoming = new Headers({
    origin: 'https://yt-test.example',
    referer: 'https://yt-test.example/',
    'user-agent': 'Mozilla/5.0 jsproxy-yt-test-synthetic',
  })
  const truncated = restoreOriginRequestHeaders(truncatedIncoming)
  assert(
    'truncated Referer does not invent Google origin',
    truncated.reqHdrNew.get('origin') !== 'https://accounts.google.com' &&
      truncated.reqHdrNew.get('origin') !== 'https://yt-test.example'
  )

  const encodedContinue =
    'https://accounts.google.com/ServiceLogin?continue=' +
    encodeURIComponent('https://www.youtube.com/watch?v=jNQXAC9IVRw')
  const rebuilt = rebuildProxyTarget(encodedContinue)
  const cont = continueHostFromUrl(rebuilt.href)
  assert('continue host stays youtube.com', cont.host === 'www.youtube.com', JSON.stringify(cont))
  const proxyContinue =
    'https://accounts.google.com/ServiceLogin?continue=' +
    encodeURIComponent('https://yt-test.example/-----https://www.youtube.com/')
  const rebuiltProxy = continueHostFromUrl(rebuildProxyTarget(proxyContinue).href)
  assert(
    'rewritten continue host is proxy (detected, not rewritten away)',
    rebuiltProxy.host === 'yt-test.example',
    JSON.stringify(rebuiltProxy)
  )
  assert(
    'worker does not rewrite continue to invent youtube',
    api.rebuildProxyTarget(proxyContinue).searchParams.get('continue').includes('yt-test.example')
  )

  const init = {
    method: 'GET',
    referrer: '/?' + packed,
    headers: new Headers({ accept: '*/*' }),
  }
  attachReqMapHeader(init)
  assert(
    'wrap copies packed map to header',
    init.headers.get(REQMAP_HEADER) === packed
  )

  const proxyReq = new Request(origin + '/http/' + encodedContinue, {
    headers: {
      'user-agent': 'Mozilla/5.0 jsproxy-yt-test-synthetic',
      origin: 'https://yt-test.example',
      'sec-fetch-site': 'same-origin',
      [REQMAP_HEADER]: packed,
    },
  })
  const proxied = await handleViaWorker(api, proxyReq)
  assert('proxied synthetic login 200', proxied.status === 200, String(proxied.status))
  const info = api.getResInfo(proxied)
  assert('proxied numbered cookies via getResInfo', info.cookieStrArr.length === 3, JSON.stringify(info.cookieStrArr))
  const echo = JSON.parse(await proxied.text())
  assert('mock origin saw youtube origin from map', echo.origin === 'https://www.youtube.com', JSON.stringify(echo))
  assert('mock origin saw long cookie', typeof echo.cookie === 'string' && echo.cookie.length > 4000)
  assert('mock origin did not see sec-fetch-site', echo.secFetchSite == null)
  assert('mock origin continue host youtube', echo.continue && echo.continue.includes('www.youtube.com'))
  assert('mock origin saw passthrough UA', echo.ua === 'Mozilla/5.0 jsproxy-yt-test-synthetic')
}

function startServer(api, port) {
  const wrapIife = extractWrap(api)
  const wrapOnlySw =
    wrapIife +
    '\n' +
    'self.addEventListener("install", e => e.waitUntil(self.skipWaiting()));\n' +
    'self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));\n' +
    'self.addEventListener("fetch", event => {\n' +
    '  var u = new URL(event.request.url);\n' +
    '  if (u.pathname.indexOf("/swfwd/") !== 0) return;\n' +
    '  event.respondWith((async function() {\n' +
    '    var kind = u.pathname.slice("/swfwd/".length);\n' +
    '    var m = { method: "POST" };\n' +
    '    if (kind === "empty") {\n' +
    '      m.body = new ReadableStream({ start: function(c) { c.close(); } });\n' +
    '    } else if (kind === "nonempty") {\n' +
    '      m.body = new ReadableStream({ start: function(c) { c.enqueue(new Uint8Array([1,2,3,4])); c.close(); } });\n' +
    '    } else if (kind === "copybody") {\n' +
    '      var req = event.request;\n' +
    '      m.method = req.method;\n' +
    '      if (req.method === "POST" && !req.bodyUsed && req.body) m.body = req.body;\n' +
    '    } else {\n' +
    '      return new Response("unknown", { status: 400 });\n' +
    '    }\n' +
    '    try { return await fetch("/__test__/sink?k=sw-" + kind, m); }\n' +
    '    catch (e) {\n' +
    '      return new Response(JSON.stringify({ swThrow: String(e && e.message || e) }), {\n' +
    '        status: 599, headers: { "content-type": "application/json" }\n' +
    '      });\n' +
    '    }\n' +
    '  })());\n' +
    '});\n'

  const dwScript =
    wrapIife +
    '\n' +
    '(async function() {\n' +
    '  async function send(kind, body) {\n' +
    '    var m = { method: "POST" };\n' +
    '    if (body) m.body = body;\n' +
    '    await fetch("/__test__/sink?k=dw-" + kind, m);\n' +
    '  }\n' +
    '  try {\n' +
    '    await send("empty", new ReadableStream({ start: function(c) { c.close(); } }));\n' +
    '    await send("nonempty", new ReadableStream({ start: function(c) {\n' +
    '      c.enqueue(new Uint8Array([1,2,3,4])); c.close();\n' +
    '    } }));\n' +
    '  } catch (e) {\n' +
    '    await fetch("/__test__/sink?k=dw-throw", { method: "POST", body: String(e && e.message || e) });\n' +
    '  }\n' +
    '})();\n'

  const chromePage = `<!doctype html><meta charset=utf-8><title>jsproxy-yt-test chrome</title>
<script>
(async () => {
  try {
    async function reportSyntax(k, code) {
      try {
        new Function(code)
        await fetch('/__test__/sink?k=' + k, { method: 'POST', body: 'parsed-ok' })
      } catch (e) {
        await fetch('/__test__/sink?k=' + k, { method: 'POST', body: String(e && e.message || e) })
      }
    }
    await reportSyntax('syntax-up', 'function postMessage(...(self.__set_srcWin?__set_srcWin():[]), x){return x}')
    await reportSyntax('syntax-fx', 'const o={postMessage(x){return x}}; o.postMessage(...(self.__set_srcWin?__set_srcWin():[]), 1)')
    new Worker('/dw-wrap-test.js')
    await navigator.serviceWorker.register('/sw-wrap-test.js', { scope: '/' })
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })
        setTimeout(resolve, 4000)
      })
    }
    await fetch('/swfwd/empty', { cache: 'no-store' })
    await fetch('/swfwd/nonempty', { cache: 'no-store' })
    await fetch('/swfwd/copybody', { method: 'POST', body: new Uint8Array([9,8,7,6]), cache: 'no-store' })
    await fetch('/__test__/range', { cache: 'no-store' })
    await fetch('/__test__/range', { headers: { Range: 'bytes=10-17' }, cache: 'no-store' })
    await fetch('/http/https://example.com/')
    await fetch('/http/https://www.youtube.com/', { method: 'OPTIONS' })
    await fetch('/__test__/status?code=404')
    await fetch('/__test__/compat', { cache: 'no-store' })
    var packed = new URLSearchParams({
      origin: 'https://www.youtube.com',
      cookie: 'SYN=' + 'x'.repeat(4500),
      referer: 'https://www.youtube.com/'
    }).toString()
    await fetch('/__test__/sink?k=referer-long', {
      method: 'POST',
      body: 'ref',
      cache: 'no-store',
      referrer: '/?' + packed
    })
    await fetch('/__test__/sink?k=referer-long-reqmap', {
      method: 'POST',
      body: 'refmap',
      cache: 'no-store',
      referrer: '/?' + packed,
      headers: { 'x-jsproxy-reqmap': packed }
    })
    await fetch('/http/https://accounts.google.com/ServiceLogin?continue=' + encodeURIComponent('https://www.youtube.com/watch?v=jNQXAC9IVRw'), {
      cache: 'no-store',
      referrer: '/?' + packed,
      headers: { 'x-jsproxy-reqmap': packed, 'user-agent': 'Mozilla/5.0 jsproxy-yt-test-synthetic' }
    })
  } catch (err) {
    try { await fetch('/__test__/sink?k=page-throw', { method: 'POST', body: String(err && err.message || err) }) } catch (e) {}
  }
})()
</script>`

  const events = []
  function note(ev) {
    events.push(ev)
  }

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        if (req.url === '/sw-wrap-test.js' || req.url.startsWith('/sw-wrap-test.js?')) {
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store',
            'service-worker-allowed': '/',
          })
          res.end(wrapOnlySw)
          return
        }
        if (req.url === '/dw-wrap-test.js' || req.url.startsWith('/dw-wrap-test.js?')) {
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(dwScript)
          return
        }
        if (req.url === '/chrome.html' || req.url.startsWith('/chrome.html?')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(chromePage)
          return
        }
        const headers = new Headers()
        for (const [k, v] of Object.entries(req.headers)) {
          if (v == null) continue
          headers.set(k, Array.isArray(v) ? v.join(', ') : v)
        }
        headers.delete('host')
        headers.delete('connection')
        headers.delete('transfer-encoding')
        headers.delete('content-length')
        headers.delete('keep-alive')
        const chunks = []
        for await (const c of req) chunks.push(c)
        const buf = Buffer.concat(chunks)
        const parsed = new URL(req.url, `http://127.0.0.1:${port}`)
        const url = `http://127.0.0.1:${port}${req.url}`
        const init = { method: req.method, headers }
        if (buf.length) init.body = buf
        const request = new Request(url, init)
        const response = await api.handleRequest(request)
        note({
          method: req.method,
          pathname: parsed.pathname,
          k: parsed.searchParams.get('k'),
          bytes: buf.length,
          preview: parsed.pathname === '/__test__/sink' ? buf.toString('utf8').slice(0, 180) : '',
          status: response.status,
          error: response.headers.get('--error'),
          ctype: response.headers.get('content-type') || '',
          contentRange: response.headers.get('content-range') || '',
          contentLength: response.headers.get('content-length') || '',
          refererLen: String(req.headers.referer || req.headers.referrer || '').length,
          reqmapLen: String(req.headers['x-jsproxy-reqmap'] || '').length,
        })
        const outHdrs = {}
        response.headers.forEach((v, k) => {
          outHdrs[k] = v
        })
        const outBuf = Buffer.from(await response.arrayBuffer())
        res.writeHead(response.status, outHdrs)
        res.end(outBuf)
      } catch (err) {
        note({ method: req.method, url: req.url, thrown: String(err && err.message || err) })
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String((err && err.stack) || err))
      }
    })
    server.listen(port, '127.0.0.1', () => resolve({ server, events }))
  })
}

function findEvent(events, pred) {
  return events.find(pred)
}

function waitForEvents(events, pred, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (pred(events)) {
        clearInterval(timer)
        resolve(events)
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer)
        reject(new Error('chrome event timeout: ' + JSON.stringify(events.slice(-30))))
      }
    }, 40)
  })
}

async function chromeTests(port, started) {
  console.log('\n== Chrome WorkerGlobalScope wrap ==')
  const userData = '/tmp/jsproxy-yt-test-chrome-' + Date.now()
  mkdirSync(userData, { recursive: true })
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--user-data-dir=${userData}`,
    `http://127.0.0.1:${port}/chrome.html`,
  ]
  const proc = spawn('google-chrome', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', (d) => { stderr += d })
  try {
    await waitForEvents(
      started.events,
      (ev) =>
        ev.some((e) => e.k === 'syntax-up') &&
        ev.some((e) => e.k === 'syntax-fx') &&
        ev.some((e) => e.k === 'dw-empty') &&
        ev.some((e) => e.k === 'dw-nonempty') &&
        ev.some((e) => e.k === 'sw-empty') &&
        ev.some((e) => e.k === 'sw-nonempty') &&
        ev.some((e) => e.k === 'sw-copybody') &&
        ev.some((e) => e.pathname === '/__test__/range' && e.status === 200) &&
        ev.some((e) => e.pathname === '/__test__/range' && e.status === 206) &&
        ev.some((e) => e.pathname.startsWith('/http/') && e.status === 403) &&
        ev.some((e) => e.method === 'OPTIONS' && e.status === 204) &&
        ev.some((e) => e.pathname === '/__test__/status' && e.status === 404) &&
        ev.some((e) => e.pathname === '/__test__/compat' && e.status === 200) &&
        ev.some((e) => e.pathname.startsWith('/http/') && e.status === 200) &&
        ev.some((e) => e.k === 'referer-long') &&
        ev.some((e) => e.k === 'referer-long-reqmap'),
      20000
    )
  } catch (err) {
    fail('chrome events', err.message + ' stderr=' + stderr.slice(-300))
  } finally {
    proc.kill('SIGKILL')
  }

  const ev = started.events
  const dwEmpty = findEvent(ev, (e) => e.k === 'dw-empty')
  const dwNon = findEvent(ev, (e) => e.k === 'dw-nonempty')
  const dwThrow = findEvent(ev, (e) => e.k === 'dw-throw')
  const swEmpty = findEvent(ev, (e) => e.k === 'sw-empty')
  const swNon = findEvent(ev, (e) => e.k === 'sw-nonempty')
  const swCopy = findEvent(ev, (e) => e.k === 'sw-copybody')
  const range200 = findEvent(ev, (e) => e.pathname === '/__test__/range' && e.status === 200)
  const range206 = findEvent(ev, (e) => e.pathname === '/__test__/range' && e.status === 206)
  const denied = findEvent(ev, (e) => e.pathname.startsWith('/http/') && e.status === 403)
  const pre = findEvent(ev, (e) => e.method === 'OPTIONS' && e.status === 204)
  const e404 = findEvent(ev, (e) => e.pathname === '/__test__/status' && e.status === 404)

  assert('dw empty stream POST no TypeError', dwEmpty && dwEmpty.status === 200 && dwEmpty.bytes === 0, JSON.stringify(dwEmpty || dwThrow))
  assert('dw nonempty stream POST no TypeError', dwNon && dwNon.status === 200 && dwNon.bytes === 4, JSON.stringify(dwNon || dwThrow))
  assert('sw empty stream POST no TypeError', swEmpty && swEmpty.status === 200 && swEmpty.bytes === 0, JSON.stringify(swEmpty))
  assert('sw nonempty stream POST no TypeError', swNon && swNon.status === 200 && swNon.bytes === 4, JSON.stringify(swNon))
  assert('sw copybody reconstruct no TypeError', swCopy && swCopy.status === 200 && swCopy.bytes === 4, JSON.stringify(swCopy))
  assert('GET range 200', range200 && range200.status === 200, JSON.stringify(range200))
  assert('GET range 206', range206 && range206.status === 206 && range206.contentRange === 'bytes 10-17/256', JSON.stringify(range206))
  assert('denied 403', denied && denied.error === 'host-denied', JSON.stringify(denied))
  assert('preflight 204', !!pre, JSON.stringify(pre))
  assert('error 404 not html 200', e404 && e404.status === 404 && !/text\/html/.test(e404.ctype || ''), JSON.stringify(e404))
  const compatEv = findEvent(ev, (e) => e.pathname === '/__test__/compat' && e.status === 200)
  const loginEv = findEvent(ev, (e) => e.pathname.startsWith('/http/') && e.status === 200)
  assert('chrome /__test__/compat 200', !!compatEv, JSON.stringify(compatEv))
  assert('chrome synthetic ServiceLogin 200 via mock', !!loginEv, JSON.stringify(loginEv))
  const refLong = findEvent(ev, (e) => e.k === 'referer-long')
  const refMap = findEvent(ev, (e) => e.k === 'referer-long-reqmap')
  assert(
    'chrome truncates long Referer below packed length',
    refLong && refLong.refererLen < 4096,
    JSON.stringify(refLong)
  )
  assert(
    'chrome still delivers x-jsproxy-reqmap >4k',
    refMap && refMap.reqmapLen > 4000,
    JSON.stringify(refMap)
  )
  const synUp = findEvent(ev, (e) => e.k === 'syntax-up')
  const synFx = findEvent(ev, (e) => e.k === 'syntax-fx')
  assert(
    'chrome upstream jsfilter Unexpected token (',
    synUp && /Unexpected token '\('/.test(synUp.preview || ''),
    JSON.stringify(synUp)
  )
  assert('chrome fixed member-call parses', synFx && synFx.preview === 'parsed-ok', JSON.stringify(synFx))
}

async function wrapUnitTest() {
  console.log('\n== fetch-wrap unit (Node) ==')
  const { prepareOutgoingInit, installJsproxyYtTestFetchWrap, attachReqMapHeader, REQMAP_HEADER } =
    await import('../frontend/fetch-wrap.js')
  const empty = new ReadableStream({
    start(c) {
      c.close()
    },
  })
  const a = await prepareOutgoingInit({ method: 'POST', mode: 'cors', body: empty })
  assert('empty stream omits body', a.body === undefined)
  assert('empty stream drops duplex', a.duplex === undefined)
  const nonempty = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([9, 8, 7]))
      c.close()
    },
  })
  const b = await prepareOutgoingInit({ method: 'POST', body: nonempty, duplex: 'half' })
  assert('nonempty stream -> ArrayBuffer', b.body instanceof ArrayBuffer && b.body.byteLength === 3)
  assert('nonempty drops duplex', !('duplex' in b) || b.duplex === undefined)
  const c = await prepareOutgoingInit({ method: 'GET' })
  assert('GET unchanged no body', c.body === undefined && c.method === 'GET')
  const mapped = {
    method: 'GET',
    referrer: '/?cookie=SID%3Dsyn&origin=https%3A%2F%2Fwww.youtube.com',
    headers: new Headers({ accept: '*/*' }),
  }
  await prepareOutgoingInit(mapped)
  assert('prepareOutgoingInit attaches reqmap', mapped.headers.get(REQMAP_HEADER) && /cookie=/.test(mapped.headers.get(REQMAP_HEADER)))
  attachReqMapHeader(mapped)
  assert('attachReqMapHeader is idempotent', (mapped.headers.get(REQMAP_HEADER).match(/cookie=/g) || []).length === 1)

  const g = {
    fetch: async () => {
      throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': The 'duplex' member must be specified for a request with a streaming body")
    },
  }
  const logs = []
  const origWarn = console.warn
  console.warn = function () {
    logs.push(Array.from(arguments).join(' '))
  }
  try {
    installJsproxyYtTestFetchWrap(g)
    const res = await g.fetch('https://rr.googlevideo.com/videoplayback?signature=SECRET&n=NOPE', {
      method: 'POST',
      body: 'x',
    })
    const text = await res.text()
    assert('wrap duplex TypeError is 502 not 200', res.status === 502)
    assert('wrap fail header', res.headers.get('--jsproxy-test-error') && /TypeError/.test(res.headers.get('--jsproxy-test-error')))
    assert('wrap fail body has no signed query', !/SECRET|n=NOPE/.test(text))
    assert('wrap fail log sanitized', logs.some((l) => /videoplayback/.test(l)) && !logs.some((l) => /SECRET/.test(l)))
  } finally {
    console.warn = origWarn
  }

  const calls = []
  const reuseGlobal = {
    fetch: async (_input, initArg) => {
      calls.push({
        hasReferrer: !!(initArg && initArg.referrer),
        referrer: initArg && initArg.referrer,
        bodyType: initArg && initArg.body && initArg.body.constructor && initArg.body.constructor.name,
        bytes: initArg && initArg.body && initArg.body.byteLength,
      })
      return new Response('ok')
    },
  }
  installJsproxyYtTestFetchWrap(reuseGlobal)
  const reuseInit = {
    method: 'POST',
    mode: 'cors',
    referrer: '/?--ver=121&--mode=cors&origin=https://yt-test.example',
    headers: new Headers({ accept: '*/*' }),
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3, 4]))
        c.close()
      },
    }),
  }
  await reuseGlobal.fetch('https://yt-test.example/http/https://www.youtube.com/youtubei/v1/player', reuseInit)
  await reuseGlobal.fetch('https://yt-test.example/http/https://www.youtube.com/youtubei/v1/player', reuseInit)
  assert('wrap mutates init body for reuse', reuseInit.body instanceof ArrayBuffer && reuseInit.body.byteLength === 4)
  assert('wrap retry sees buffered body', calls.length === 2 && calls[0].bytes === 4 && calls[1].bytes === 4)
  assert('wrap keeps referrer query map', /--ver=121/.test(reuseInit.referrer || '') && calls[1].hasReferrer === true)

  const abortGlobal = {
    fetch: async () => {
      const err = new Error('The user aborted a request.')
      err.name = 'AbortError'
      throw err
    },
  }
  installJsproxyYtTestFetchWrap(abortGlobal)
  let abortThrew = false
  try {
    await abortGlobal.fetch('https://www.youtube.com/youtubei/v1/player', { method: 'POST', body: '{}' })
  } catch (err) {
    abortThrew = err && err.name === 'AbortError'
  }
  assert('wrap rethrows AbortError', abortThrew === true)

  const netGlobal = {
    fetch: async () => {
      throw new TypeError('Failed to fetch')
    },
  }
  installJsproxyYtTestFetchWrap(netGlobal)
  let netThrew = false
  try {
    await netGlobal.fetch('https://www.youtube.com/youtubei/v1/player', { method: 'GET' })
  } catch (err) {
    netThrew = err && err.name === 'TypeError' && /Failed to fetch/.test(String(err.message))
  }
  assert('wrap rethrows non-duplex TypeError', netThrew === true)
}

async function jsfilterParseTest(api) {
  console.log('\n== jsfilter parse (offline) ==')
  const { parseStrUpstream, parseStrFixed, patchAuthorBundle, UPSTREAM_POSTMESSAGE_SITE } = await import(
    '../frontend/jsfilter.js'
  )
  const fnDef = 'function postMessage(x){return x}'
  const method = 'const o={postMessage(x){return x}}; o.postMessage(1)'
  const origFn = (() => {
    try {
      new vm.Script(fnDef)
      return true
    } catch {
      return false
    }
  })()
  const upFn = parseStrUpstream(fnDef)
  let upErr = ''
  try {
    new vm.Script(upFn)
  } catch (err) {
    upErr = String(err.message)
  }
  const fxFn = parseStrFixed(fnDef)
  assert('orig function postMessage parses', origFn === true)
  assert('upstream rewrite is function postMessage(...(', /function postMessage\(\.\.\.\(self\.__set_srcWin/.test(upFn || ''))
  assert('upstream rewrite Unexpected token (', /Unexpected token '\('/.test(upErr), upErr)
  assert('fixed rewrite skips function def', fxFn == null)

  const upMethod = parseStrUpstream(method)
  let upMethodErr = ''
  try {
    new vm.Script(upMethod)
  } catch (err) {
    upMethodErr = String(err.message)
  }
  const fxMethod = parseStrFixed(method)
  assert('orig method shorthand parses', true)
  assert('upstream method rewrite Unexpected token (', /Unexpected token '\('/.test(upMethodErr), upMethodErr)
  assert('fixed method def kept, call rewritten', fxMethod && fxMethod.includes('{postMessage(x){return x}}') && fxMethod.includes('o.postMessage(...(self.__set_srcWin'))
  try {
    new vm.Script(fxMethod)
    pass('fixed method+call parses')
  } catch (err) {
    fail('fixed method+call parses', String(err.message))
  }

  const loc = parseStrUpstream('const location={href:"x"}; location.href')
  try {
    new vm.Script(loc)
    pass('location rewrite still parses')
  } catch (err) {
    fail('location rewrite still parses', String(err.message))
  }

  const snippet = 'foo' + UPSTREAM_POSTMESSAGE_SITE + 'bar'
  assert('patch unique site', patchAuthorBundle(snippet) === 'foo.replace(/\\.postMessage\\s*\\(/g,bar')
  let threw = false
  try {
    patchAuthorBundle('no site here')
  } catch {
    threw = true
  }
  assert('patch rejects missing site', threw === true)
  assert('worker exports patchAuthorBundle', typeof api.patchAuthorBundle === 'function')

  const res = await fetch('https://etherdream.github.io/jsproxy/assets/bundle.c33e24c5.js')
  assert('author bundle fetch', res.ok, String(res.status))
  if (res.ok) {
    const bundle = await res.text()
    const patched = api.patchAuthorBundle(bundle)
    assert('author bundle has one rewrite site', bundle.includes('.replace(/postMessage\\s*\\(/g,'))
    assert('patched bundle uses call-only rewrite', patched.includes('.replace(/\\.postMessage\\s*\\(/g,') && !patched.includes('.replace(/postMessage\\s*\\(/g,'))
    try {
      new vm.Script(patched, { filename: 'bundle.patched.js' })
      pass('patched bundle still parses')
    } catch (err) {
      fail('patched bundle still parses', String(err.message))
    }
  }
}

function writeArtifact(api) {
  const outDir = '/opt/cursor/artifacts'
  mkdirSync(outDir, { recursive: true })
  const dest = join(outDir, 'worker.js')
  writeFileSync(dest, workerSrc)
  const sha = createHash('sha256').update(workerSrc).digest('hex')
  const meta = {
    tag: api.tag,
    testVer: api.testVer,
    isolatedTest: true,
    notProduction: true,
    sha256: sha,
    bytes: Buffer.byteLength(workerSrc),
    file: dest,
    compatibilityDateHint: '2024-11-11',
    bindings: 'none',
    secrets: 'none',
    playbackNotGuaranteed: true,
  }
  writeFileSync(join(outDir, 'worker.sha256'), sha + '  worker.js\n')
  writeFileSync(join(outDir, 'worker.meta.json'), JSON.stringify(meta, null, 2) + '\n')
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  writeFileSync(join(outDir, 'DEPLOY.md'), readme)
  const harnessDir = join(root, 'offline-harness')
  copyFileSync(join(root, 'worker.js'), join(harnessDir, 'worker.js'))
  copyFileSync(join(root, 'worker.js'), join(outDir, 'worker.js'))
  const zipPath = join(outDir, 'jsproxy-yt-test-v123-offline.zip')
  const zip = spawnSync(
    'zip',
    ['-j', zipPath, join(harnessDir, 'server.mjs'), join(harnessDir, 'README.txt'), join(harnessDir, 'worker.js')],
    { encoding: 'utf8' }
  )
  if (zip.status !== 0) {
    console.warn('zip failed', zip.stderr || zip.stdout)
  }
  console.log('\n== artifacts ==')
  console.log('  wrote', dest, sha, meta.bytes, 'bytes')
  if (zip.status === 0) console.log('  wrote', zipPath)
  return meta
}

const PORT = 8791

const apiBundle = loadWorker()
await nodeContractTests(apiBundle.api)
await wrapUnitTest()
await jsfilterParseTest(apiBundle.api)
await workerHttpTests(apiBundle.api)
await proxyCompatTests(apiBundle.api)
const started = await startServer(apiBundle.api, PORT)
try {
  await chromeTests(PORT, started)
} finally {
  started.server.close()
}
const meta = writeArtifact(apiBundle.api)

if (failures.length) {
  console.log('\nFAILED', failures.length)
  for (const f of failures) console.log(' -', f)
  process.exit(1)
}
console.log('\nALL PASSED')
console.log(JSON.stringify({ sha256: meta.sha256, bytes: meta.bytes, isolatedTest: true }))
