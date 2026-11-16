'use strict'

/**
 * jsproxy YouTube 隔离测试 Worker（不是生产 https://js.jimmytinsley.com）
 *
 * 部署：Cloudflare Dashboard → Workers → Create → 粘贴本文件 → Save。
 * 无需 KV / R2 / 密钥 / 环境变量 / 路由绑定。compatibility_date 用仪表盘默认即可；
 * 若必须填写，用 2024-11-11。
 *
 * 本文件会：
 * - 自己提供修正后的 /sw.js（fetch 包装：缓冲 ReadableStream POST）和 /conf.js
 * - 从测试 origin 提供作者未改 bundle（反代 etherdream.github.io）
 * - 只代理 YouTube/Google 播放相关公开域
 * - 关闭 static_boost，节点只有 mysite=自身
 */

var TEST_TAG = 'jsproxy-yt-test'
var TEST_VER = '121'
var JS_VER = 10
var BUNDLE_NAME = 'bundle.c33e24c5.js'
var UPSTREAM_STATIC = 'https://etherdream.github.io/jsproxy'

/** @type {string[]} exact or suffix match via "." + domain */
var ALLOWED_HOST_SUFFIXES = [
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

var PREFLIGHT_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
  'access-control-max-age': '1728000',
}

var staticCache = new Map()
var STATIC_CACHE_MAX = 32

function sanitizeUrl(u) {
  try {
    var x = new URL(typeof u === 'string' ? u : (u && u.url) || '')
    return x.origin + x.pathname
  } catch (err) {
    return '[unparseable-url]'
  }
}

function hostAllowed(host) {
  if (!host) return false
  host = String(host).toLowerCase()
  for (var i = 0; i < ALLOWED_HOST_SUFFIXES.length; i++) {
    var d = ALLOWED_HOST_SUFFIXES[i]
    if (host === d || host.endsWith('.' + d)) return true
  }
  return false
}

function corsHeaders(extra) {
  var h = {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': '--s,--ver,--error,--jsproxy-test,--jsproxy-test-error,--denied-host',
    '--ver': String(JS_VER),
    '--jsproxy-test': '1',
  }
  if (extra) {
    var keys = Object.keys(extra)
    for (var i = 0; i < keys.length; i++) h[keys[i]] = extra[keys[i]]
  }
  return h
}

function makeRes(body, status, extraHeaders) {
  var st = status || 200
  var extra = extraHeaders ? Object.assign({}, extraHeaders) : {}
  if (extra['--s'] == null) extra['--s'] = String(st)
  return new Response(body, {
    status: st,
    headers: corsHeaders(extra),
  })
}

function makeJson(obj, status) {
  return makeRes(JSON.stringify(obj, null, 2), status || 200, {
    'content-type': 'application/json; charset=utf-8',
  })
}

function newUrl(urlStr) {
  try {
    return new URL(urlStr)
  } catch (err) {
    return null
  }
}

/**
 * SW 内嵌包装。由 `node cf-worker-test/build.mjs` 从 frontend/fetch-wrap.js 生成。
 * 缓冲流 body，失败返回 502 而不是抛给 bundle 变成 200 load fail。
 */
/* <FETCH_WRAP_IIFE_BEGIN> */
var FETCH_WRAP_IIFE = "// <JSPROXY_YT_TEST_FETCH_WRAP>\n(function(){\n/**\n * SW 侧 fetch 包装：在作者 bundle.c33e24c5.js 调用 fetch(proxyUrl, init)\n * 之前把 ReadableStream body 缓冲成 ArrayBuffer，并写回同一个 init，\n * 以便 network.launch() 的重试循环能复用正文。\n *\n * 这是针对 Chrome 105+ 的构造期异常：\n *   TypeError: Failed to execute 'fetch' on 'WorkerGlobalScope':\n *   The 'duplex' member must be specified for a request with a streaming body\n *\n * 评估结论：只加 duplex half 能过构造检查，但对 /http/ 代理路径仍会\n * 因流式上传 CORS 预检失败。缓冲 body 后请求变为普通 POST。\n *\n * 不要把带 init 的任意 fetch 失败收成 502：AbortError / 普通网络错误若变成\n * “成功的 502 响应”，播放器会把非 JSON 当 innertube 结果，表现为无时长、无 src。\n * 仅 duplex TypeError 才返回 502，避免 bundle 合成误导性 200 load fail。\n */\n\nfunction sanitizeUrl(u) {\n  try {\n    const x = new URL(typeof u === 'string' ? u : (u && u.url) || '')\n    return x.origin + x.pathname\n  } catch (err) {\n    return '[unparseable-url]'\n  }\n}\n\nfunction isDuplexTypeError(err) {\n  const name = (err && err.name) || ''\n  const message = String((err && err.message) || err)\n  return name === 'TypeError' && /duplex/i.test(message)\n}\n\n/**\n * 原地改 init：流 body → ArrayBuffer（空流则删除 body）。\n * 必须写回同一对象，bundle 重试时仍用这个 init。\n * @param {RequestInit} init\n * @returns {Promise<RequestInit>}\n */\nasync function prepareOutgoingInit(init) {\n  const out = init || {}\n  const body = out.body\n  if (body && typeof body.getReader === 'function') {\n    const buf = await new Response(body).arrayBuffer()\n    if (buf.byteLength > 0) {\n      out.body = buf\n    } else {\n      delete out.body\n    }\n    delete out.duplex\n  }\n  return out\n}\n\nfunction installJsproxyYtTestFetchWrap(global) {\n  const rawFetch = global.fetch.bind(global)\n\n  global.fetch = async function (input, init) {\n    if (init !== undefined) {\n      await prepareOutgoingInit(init)\n    }\n    try {\n      if (init !== undefined) {\n        return await rawFetch(input, init)\n      }\n      return await rawFetch(input)\n    } catch (err) {\n      if (init === undefined || !isDuplexTypeError(err)) {\n        throw err\n      }\n      const name = (err && err.name) || 'Error'\n      const message = String((err && err.message) || err).slice(0, 180)\n      const where = sanitizeUrl(typeof input === 'string' ? input : (input && input.url))\n      console.warn('[jsproxy-yt-test] fetch fail', name, message, where)\n      return new Response('jsproxy-yt-test fetch failed: ' + name + ':' + message, {\n        status: 502,\n        headers: {\n          'content-type': 'text/plain;charset=utf-8',\n          'access-control-expose-headers': '--jsproxy-test,--jsproxy-test-error,--s',\n          '--jsproxy-test': '1',\n          '--jsproxy-test-error': name + ':' + message,\n          '--s': '502',\n        },\n      })\n    }\n  }\n}\ninstallJsproxyYtTestFetchWrap(self);\n})();\n// </JSPROXY_YT_TEST_FETCH_WRAP>"
/* <FETCH_WRAP_IIFE_END> */

function swScript() {
  return [
    '/* ' + TEST_TAG + ' sw ' + TEST_VER + ' */',
    FETCH_WRAP_IIFE,
    "jsproxy_config=x=>{__CONF__=x;importScripts(__FILE__=x.assets_cdn+'" + BUNDLE_NAME + "')};",
    "importScripts('conf.js');",
  ].join('\n')
}

function confScript() {
  return [
    '/* ' + TEST_TAG + ' conf ' + TEST_VER + ' isolated-test; not production */',
    'jsproxy_config({',
    "  ver: '" + TEST_VER + "',",
    '  static_boost: { enable: false, ver: 0 },',
    '  node_map: {',
    "    mysite: { label: '隔离测试Worker(自身)', lines: { [location.host]: 1 } }",
    '  },',
    "  node_default: 'mysite',",
    "  node_acc: 'mysite',",
    "  assets_cdn: 'assets/',",
    "  index_path: 'index_v3.html',",
    "  direct_host_list: 'cors_v1.txt',",
    "  inject_html: '<!-- jsproxy-yt-test isolated; not production; not a playback guarantee -->',",
    '  url_handler: {}',
    '})',
  ].join('\n')
}

function installerHtml() {
  return '<!doctype html><html><head><meta charset=utf-8><title>jsproxy-yt-test</title></head>' +
    '<body id=t>' +
    '<p>隔离测试版 SW 安装中… 这不是生产 js.jimmytinsley.com。</p>' +
    '<script>' +
    'function a(){var e=Date.now();try{var t=+sessionStorage._ts||0;if((sessionStorage._ts=e)-t<100)return setTimeout(a,5e3)}catch(r){}location.reload()}' +
    'function i(e){t.innerHTML=e.message||e}' +
    '!function(){if(!self.isSecureContext)return i("需要 HTTPS 或 localhost");' +
    'if(!self.ReadableStream)return i("请使用新版 Chrome");' +
    'var e=navigator.serviceWorker;if(!e)return i("无 Service Worker");' +
    'e.register(location.pathname.replace(/\\/-+https?:.+/,"").replace(/\\w+\\.\\w+$/,"").replace(/\\/*$/,"/")+"sw.js").then(a).catch(i)' +
    '}()' +
    '</script></body></html>'
}

function indexHtml() {
  return '<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">' +
    '<title>jsproxy-yt-test（隔离测试）</title>' +
    '<style>body{font-family:sans-serif;max-width:42em;margin:1.5em} .warn{background:#fff3cd;padding:1em;border:1px solid #c9a227} input,button{font-size:1.1em;width:100%;margin:.4em 0;padding:.4em} a{word-break:break-all}</style>' +
    '</head><body>' +
    '<div class=warn><strong>隔离测试 Worker</strong>，不是生产 <code>https://js.jimmytinsley.com</code>。' +
    '本页只验证 SW 流式 POST 构造修复；<strong>不承诺 YouTube 能播</strong>。' +
    '请在未注册过生产 SW 的配置/隐私窗口打开本 origin。</div>' +
    '<p>测试标签 <code>' + TEST_TAG + '</code> · conf.ver <code>' + TEST_VER + '</code> · bundle <code>' + BUNDLE_NAME + '</code>（作者未改字节，经本 origin 提供）</p>' +
    '<input id=txtURL value="https://www.youtube.com/watch?v=jNQXAC9IVRw">' +
    '<button id=btnGo>打开代理（新窗口）</button>' +
    '<p>SW 控制本页后，相对路径会被当成 Google 搜索。自检请用终端（不要在本页打开 /__test__/info）：</p>' +
    '<p><code id=curlHint></code></p>' +
    '<p>浏览器只读诊断：Network 里是否出现 <code>watch?v=</code> 的文档、<code>youtubei/v1/player</code> POST、以及随后的 <code>videoplayback</code>。Console 是否还有 duplex TypeError / JSON parse。Play 后看 video.src / duration。</p>' +
    '<script>' +
    'curlHint.textContent="curl -sS https://"+location.host+"/__test__/info";' +
    'btnGo.onclick=function(){var t=txtURL.value.trim();if(!t)return;if(!/^https?:/i.test(t))t="https://"+t;open("./-----"+t,"_blank","noopener,noreferrer")};' +
    'txtURL.onkeypress=function(e){if(e.keyCode===13)btnGo.onclick()};' +
    '</script></body></html>'
}

async function cachedUpstream(path) {
  var key = path
  if (staticCache.has(key)) return staticCache.get(key)
  var url = UPSTREAM_STATIC + path
  var res = await fetch(url, { redirect: 'follow' })
  var buf = await res.arrayBuffer()
  var headers = {
    'content-type': res.headers.get('content-type') || 'application/octet-stream',
    'cache-control': 'public, max-age=300',
    '--jsproxy-test': '1',
    '--jsproxy-test-upstream': sanitizeUrl(url),
  }
  var item = { status: res.status, buf: buf, headers: headers }
  if (res.ok && staticCache.size < STATIC_CACHE_MAX) staticCache.set(key, item)
  return item
}

function serveCached(item) {
  return new Response(item.buf, { status: item.status, headers: corsHeaders(item.headers) })
}

async function serveStaticAsset(rel) {
  if (rel === 'index_v3.html') {
    return makeRes(indexHtml(), 200, { 'content-type': 'text/html; charset=utf-8' })
  }
  if (rel === 'cors_v1.txt') {
    return makeRes('# jsproxy-yt-test: empty direct-host list so traffic stays on mysite\n', 200, {
      'content-type': 'text/plain; charset=utf-8',
    })
  }
  var path = '/assets/' + rel.replace(/^\/+/, '')
  try {
    return serveCached(await cachedUpstream(path))
  } catch (err) {
    return makeRes('upstream static fail: ' + String((err && err.message) || err), 502, {
      '--error': 'static-upstream',
    })
  }
}

function testRangeBody() {
  var bytes = new Uint8Array(256)
  for (var i = 0; i < 256; i++) bytes[i] = i
  return bytes
}

function handleTestRange(req) {
  var bytes = testRangeBody()
  var range = req.headers.get('range')
  if (!range) {
    return new Response(bytes, {
      status: 200,
      headers: corsHeaders({
        'content-type': 'application/octet-stream',
        'accept-ranges': 'bytes',
        'content-length': String(bytes.length),
      }),
    })
  }
  var m = String(range).match(/bytes=(\d+)-(\d*)/i)
  if (!m) return makeRes('bad range', 400, { '--error': 'bad-range' })
  var start = parseInt(m[1], 10)
  var end = m[2] === '' ? bytes.length - 1 : parseInt(m[2], 10)
  if (isNaN(start) || isNaN(end) || start > end || start >= bytes.length) {
    return makeRes('unsatisfiable', 416, { '--error': 'range' })
  }
  if (end >= bytes.length) end = bytes.length - 1
  var slice = bytes.subarray(start, end + 1)
  return new Response(slice, {
    status: 206,
    headers: corsHeaders({
      'content-type': 'application/octet-stream',
      'accept-ranges': 'bytes',
      'content-range': 'bytes ' + start + '-' + end + '/' + bytes.length,
      'content-length': String(slice.length),
    }),
  })
}

async function handleTestSink(req) {
  var buf = await req.arrayBuffer()
  return makeJson({
    tag: TEST_TAG,
    method: req.method,
    bytes: buf.byteLength,
    contentType: req.headers.get('content-type'),
  })
}

async function handleTestInfo(req) {
  var url = new URL(req.url)
  return makeJson({
    tag: TEST_TAG,
    isolatedTest: true,
    notProduction: true,
    productionHost: 'js.jimmytinsley.com',
    testVer: TEST_VER,
    jsVer: JS_VER,
    bundle: BUNDLE_NAME,
    host: url.host,
    staticBoost: false,
    node: 'mysite=self',
    allowedHostSuffixes: ALLOWED_HOST_SUFFIXES,
    wrapInPlaceBody: true,
    wrapAbortRethrow: true,
    playbackNotGuaranteed: true,
  })
}

async function httpHandler(req, pathname) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(PREFLIGHT_HEADERS) })
  }

  var urlStr = pathname.replace(/^(https?):\/+/, '$1://')
  var urlObj = newUrl(urlStr)
  if (!urlObj) {
    return makeRes('invalid proxy url', 403, { '--error': 'invalid-url' })
  }
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    return makeRes('protocol not allowed', 403, { '--error': 'protocol' })
  }
  if (!hostAllowed(urlObj.hostname)) {
    console.warn('[jsproxy-yt-test] deny host', urlObj.hostname)
    return makeRes('host not allowed for this isolated YouTube test worker: ' + urlObj.hostname, 403, {
      '--error': 'host-denied',
      '--denied-host': urlObj.hostname,
      'content-type': 'text/plain; charset=utf-8',
    })
  }

  var reqHdrRaw = req.headers
  if (reqHdrRaw.has('x-jsproxy')) {
    return Response.error()
  }

  var acehOld = false
  var rawLen = ''
  var reqHdrNew = new Headers(reqHdrRaw)
  reqHdrNew.set('x-jsproxy', '1')

  var refer = reqHdrNew.get('referer') || reqHdrNew.get('referrer') || ''
  var qPos = refer.indexOf('?')
  if (qPos >= 0) {
    var param = new URLSearchParams(refer.substr(qPos + 1))
    param.forEach(function (v, k) {
      if (k.substr(0, 2) === '--') {
        if (k.substr(2) === 'aceh') acehOld = true
        if (k.substr(2) === 'raw-info') {
          var parts = String(v).split('|')
          rawLen = parts[1] || ''
        }
      } else if (v) {
        reqHdrNew.set(k, v)
      } else {
        reqHdrNew.delete(k)
      }
    })
    if (!param.has('referer')) reqHdrNew.delete('referer')
  }

  var reqInit = {
    method: req.method,
    headers: reqHdrNew,
    redirect: 'manual',
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    var buf = await req.arrayBuffer()
    if (buf.byteLength > 0) reqInit.body = buf
  }

  var res
  try {
    res = await fetch(urlObj.href, reqInit)
  } catch (err) {
    var msg = String((err && err.message) || err).slice(0, 180)
    console.warn('[jsproxy-yt-test] origin fetch fail', sanitizeUrl(urlObj.href), msg)
    return makeRes('origin fetch failed: ' + msg, 502, {
      '--error': 'origin-fetch',
      'content-type': 'text/plain; charset=utf-8',
    })
  }

  var resHdrOld = res.headers
  var resHdrNew = new Headers(resHdrOld)
  var expose = '*'
  resHdrOld.forEach(function (val, key) {
    if (
      key === 'access-control-allow-origin' ||
      key === 'access-control-expose-headers' ||
      key === 'location' ||
      key === 'set-cookie'
    ) {
      resHdrNew.set('--' + key, val)
      resHdrNew.delete(key)
    }
  })

  if (acehOld) {
    expose = expose + ',--s'
    resHdrNew.set('--t', '1')
  }

  var status = res.status
  resHdrNew.set('access-control-expose-headers', expose)
  resHdrNew.set('access-control-allow-origin', '*')
  resHdrNew.set('--s', String(status))
  resHdrNew.set('--ver', String(JS_VER))
  resHdrNew.set('--jsproxy-test', '1')
  resHdrNew.delete('content-security-policy')
  resHdrNew.delete('content-security-policy-report-only')
  resHdrNew.delete('clear-site-data')

  if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
    status = status + 10
  }

  return new Response(res.body, { status: status, headers: resHdrNew })
}

async function handleRequest(req) {
  var urlObj = new URL(req.url)
  var path = urlObj.href.substr(urlObj.origin.length)
  var pathname = urlObj.pathname

  if (urlObj.protocol === 'http:' && urlObj.hostname !== '127.0.0.1' && urlObj.hostname !== 'localhost') {
    urlObj.protocol = 'https:'
    return makeRes('', 301, { location: urlObj.href })
  }

  if (pathname === '/works') {
    return makeRes('it works', 200, { 'content-type': 'text/plain; charset=utf-8' })
  }

  if (pathname === '/__test__/info') return handleTestInfo(req)
  if (pathname === '/__test__/sink') return handleTestSink(req)
  if (pathname === '/__test__/range') return handleTestRange(req)
  if (pathname === '/__test__/status') {
    var code = parseInt(urlObj.searchParams.get('code') || '404', 10)
    if (isNaN(code) || code < 400 || code > 599) code = 404
    return makeRes('status ' + code, code, {
      '--error': 'status',
      'content-type': 'text/plain; charset=utf-8',
    })
  }

  if (pathname === '/sw.js') {
    return makeRes(swScript(), 200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'service-worker-allowed': '/',
    })
  }
  if (pathname === '/conf.js') {
    return makeRes(confScript(), 200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
    })
  }

  if (pathname === '/' || pathname === '/index.html' || pathname === '/404.html') {
    return makeRes(installerHtml(), 200, { 'content-type': 'text/html; charset=utf-8' })
  }

  if (pathname.indexOf('/assets/') === 0) {
    return serveStaticAsset(pathname.slice('/assets/'.length))
  }

  if (pathname.indexOf('/http/') === 0) {
    return httpHandler(req, path.slice('/http/'.length))
  }
  if (pathname === '/http') {
    return makeRes('jsproxy-yt-test: use /http/https://host/...', 400, { '--error': 'bad-http-path' })
  }

  if (pathname === '/favicon.ico') {
    try {
      return serveCached(await cachedUpstream('/favicon.ico'))
    } catch (err) {
      return makeRes('', 204)
    }
  }

  return makeRes(installerHtml(), 200, { 'content-type': 'text/html; charset=utf-8' })
}

self.__JSPROXY_YT_TEST__ = {
  tag: TEST_TAG,
  testVer: TEST_VER,
  hostAllowed: hostAllowed,
  sanitizeUrl: sanitizeUrl,
  handleRequest: handleRequest,
  swScript: swScript,
}

self.addEventListener('fetch', function (event) {
  event.respondWith(
    handleRequest(event.request).catch(function (err) {
      return makeRes('cfworker error: ' + String((err && err.message) || err), 502, {
        '--error': 'worker-throw',
        'content-type': 'text/plain; charset=utf-8',
      })
    })
  )
})
