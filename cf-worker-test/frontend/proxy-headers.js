/**
 * 测试 Worker 请求/响应头编解码（与 worker.js httpHandler 同步）。
 * 不伪造 UA / sec-fetch / Origin；只做代理 hop 的正确搬运。
 */

export const REQMAP_HEADER = 'x-jsproxy-reqmap'

const HOP_DROP_EXACT = {
  host: 1,
  connection: 1,
  'keep-alive': 1,
  'proxy-connection': 1,
  'transfer-encoding': 1,
  te: 1,
  trailer: 1,
  upgrade: 1,
  cookie: 1,
  origin: 1,
  referer: 1,
  referrer: 1,
  [REQMAP_HEADER]: 1,
  'x-forwarded-for': 1,
  'x-forwarded-proto': 1,
  'x-real-ip': 1,
}

function shouldDropHopHeader(key) {
  const k = String(key).toLowerCase()
  if (HOP_DROP_EXACT[k]) return true
  if (k.indexOf('cf-') === 0) return true
  if (k.indexOf('sec-fetch-') === 0) return true
  return false
}

export function packedQueryFromReferrer(referrer) {
  if (typeof referrer !== 'string') return ''
  const qPos = referrer.indexOf('?')
  if (qPos < 0) return ''
  return referrer.slice(qPos + 1)
}

/**
 * 把 bundle `referrer: '/?' + URLSearchParams(reqMap)` 复制到自定义头。
 * Chrome 会把 >4KB 的 Referer 收成 origin（Chromium 77+），query 里的 cookie 会丢。
 * 同 origin 的 SW→Worker fetch 可以带自定义头，不改 Origin 语义。
 */
export function attachReqMapHeader(init) {
  const out = init || {}
  const packed = packedQueryFromReferrer(out.referrer)
  if (!packed) return out
  const headers = new Headers(out.headers || undefined)
  if (!headers.has(REQMAP_HEADER)) {
    headers.set(REQMAP_HEADER, packed)
  }
  out.headers = headers
  return out
}

export function readPackedReqMap(reqHdr) {
  const packed = reqHdr.get(REQMAP_HEADER)
  if (packed) return packed
  const refer = reqHdr.get('referer') || reqHdr.get('referrer') || ''
  return packedQueryFromReferrer(refer)
}

/**
 * 从 SW 请求还原要发给 origin 的头。
 * - cookie / origin / referer 只来自 packed map（作者 bundle 的 reqMap）
 * - user-agent 若 map 未带，则保留浏览器打到 Worker 的那份（透传，不合成）
 * - 丢掉 SW→Worker hop 的 sec-fetch-* / cf-* ，避免把 same-origin hop 元数据交给上游
 */
export function restoreOriginRequestHeaders(reqHdrRaw) {
  const incomingUa = reqHdrRaw.get('user-agent')
  const reqHdrNew = new Headers()
  reqHdrRaw.forEach(function (val, key) {
    if (shouldDropHopHeader(key)) return
    reqHdrNew.set(key, val)
  })

  const packed = readPackedReqMap(reqHdrRaw)
  const restored = Object.create(null)
  let acehOld = false
  let rawLen = ''

  if (packed) {
    const param = new URLSearchParams(packed)
    param.forEach(function (v, k) {
      restored[k] = true
      if (k.substr(0, 2) === '--') {
        if (k.substr(2) === 'aceh') acehOld = true
        if (k.substr(2) === 'raw-info') {
          rawLen = String(v).split('|')[1] || ''
        }
      } else if (v) {
        reqHdrNew.set(k, v)
      } else {
        reqHdrNew.delete(k)
      }
    })
    if (!param.has('referer')) reqHdrNew.delete('referer')
  }

  if (!restored['user-agent'] && incomingUa) {
    reqHdrNew.set('user-agent', incomingUa)
  }
  reqHdrNew.set('x-jsproxy', '1')
  reqHdrNew.delete(REQMAP_HEADER)

  return { reqHdrNew, acehOld, rawLen, restored, packed: packed || '' }
}

export function collectSetCookie(headers) {
  if (headers && typeof headers.getSetCookie === 'function') {
    const arr = headers.getSetCookie()
    if (arr && arr.length) return arr.slice()
  }
  if (headers && typeof headers.getAll === 'function') {
    try {
      const arr = headers.getAll('set-cookie')
      if (arr && arr.length) return arr.slice()
    } catch (err) {
      /* getAll 在标准 Headers 上会抛，只用于 CF 旧 API */
    }
  }
  const one = headers && headers.get('set-cookie')
  return one ? [one] : []
}

/**
 * 把上游响应头编成 SW 能读的转义字段。
 * 多 Set-Cookie → `1-set-cookie` … `N-set-cookie`（对齐 lua/http-enc-res-hdr.lua）。
 * 单枚仍用 `--set-cookie`，与作者 getResInfo 两条路径都兼容。
 */
export function encodeEscapedResHeaders(resHdrOld, acehOld) {
  const resHdrNew = new Headers()
  let expose = '*'

  resHdrOld.forEach(function (val, key) {
    if (key === 'set-cookie') return
    if (
      key === 'access-control-allow-origin' ||
      key === 'access-control-expose-headers' ||
      key === 'location'
    ) {
      resHdrNew.set('--' + key, val)
      return
    }
    resHdrNew.set(key, val)
  })

  const cookies = collectSetCookie(resHdrOld)
  if (cookies.length === 1) {
    resHdrNew.set('--set-cookie', cookies[0])
    if (acehOld) expose += ',--set-cookie'
  } else if (cookies.length > 1) {
    for (let i = 0; i < cookies.length; i++) {
      const name = i + 1 + '-set-cookie'
      resHdrNew.set(name, cookies[i])
      if (acehOld) expose += ',' + name
    }
  }

  return { resHdrNew, expose, cookies }
}

/** v122 对照：Headers.set 折叠多枚 cookie。 */
export function encodeSetCookieV122Collapsed(resHdrOld) {
  const resHdrNew = new Headers()
  resHdrOld.forEach(function (val, key) {
    if (
      key === 'access-control-allow-origin' ||
      key === 'access-control-expose-headers' ||
      key === 'location' ||
      key === 'set-cookie'
    ) {
      resHdrNew.set('--' + key, val)
    }
  })
  return resHdrNew
}

export function continueHostFromUrl(href) {
  try {
    const u = new URL(href)
    const c = u.searchParams.get('continue')
    if (!c) return { continue: null, host: null, parseError: false }
    try {
      return { continue: c, host: new URL(c).host, parseError: false }
    } catch (err) {
      return { continue: c, host: null, parseError: true }
    }
  } catch (err) {
    return { continue: null, host: null, parseError: true }
  }
}

export function rebuildProxyTarget(pathnameFromHttp) {
  const urlStr = String(pathnameFromHttp).replace(/^(https?):\/+/, '$1://')
  try {
    return new URL(urlStr)
  } catch (err) {
    return null
  }
}
