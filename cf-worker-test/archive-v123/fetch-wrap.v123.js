/**
 * SW 侧 fetch 包装：在作者 bundle.c33e24c5.js 调用 fetch(proxyUrl, init)
 * 之前把 ReadableStream body 缓冲成 ArrayBuffer，并写回同一个 init，
 * 以便 network.launch() 的重试循环能复用正文。
 *
 * 这是针对 Chrome 105+ 的构造期异常：
 *   TypeError: Failed to execute 'fetch' on 'WorkerGlobalScope':
 *   The 'duplex' member must be specified for a request with a streaming body
 *
 * 评估结论：只加 duplex half 能过构造检查，但对 /http/ 代理路径仍会
 * 因流式上传 CORS 预检失败。缓冲 body 后请求变为普通 POST。
 *
 * 不要把带 init 的任意 fetch 失败收成 502：AbortError / 普通网络错误若变成
 * “成功的 502 响应”，播放器会把非 JSON 当 innertube 结果，表现为无时长、无 src。
 * 仅 duplex TypeError 才返回 502，避免 bundle 合成误导性 200 load fail。
 */

export function sanitizeUrl(u) {
  try {
    const x = new URL(typeof u === 'string' ? u : (u && u.url) || '')
    return x.origin + x.pathname
  } catch (err) {
    return '[unparseable-url]'
  }
}

function isDuplexTypeError(err) {
  const name = (err && err.name) || ''
  const message = String((err && err.message) || err)
  return name === 'TypeError' && /duplex/i.test(message)
}

/**
 * 原地改 init：流 body → ArrayBuffer（空流则删除 body）。
 * 必须写回同一对象，bundle 重试时仍用这个 init。
 * @param {RequestInit} init
 * @returns {Promise<RequestInit>}
 */
export const REQMAP_HEADER = 'x-jsproxy-reqmap'

export function packedQueryFromReferrer(referrer) {
  if (typeof referrer !== 'string') return ''
  const qPos = referrer.indexOf('?')
  if (qPos < 0) return ''
  return referrer.slice(qPos + 1)
}

/**
 * 作者 bundle 把 cookie/origin 塞进 fetch referrer query。
 * Chrome ≥77 会把超过 4096 字节的 Referer 收成 origin，query 丢失。
 * 同 origin Worker 请求可另带 x-jsproxy-reqmap，不改 Origin 语义、不合成指纹。
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

export async function prepareOutgoingInit(init) {
  const out = init || {}
  const body = out.body
  if (body && typeof body.getReader === 'function') {
    const buf = await new Response(body).arrayBuffer()
    if (buf.byteLength > 0) {
      out.body = buf
    } else {
      delete out.body
    }
    delete out.duplex
  }
  attachReqMapHeader(out)
  return out
}

export function installJsproxyYtTestFetchWrap(global) {
  const rawFetch = global.fetch.bind(global)

  global.fetch = async function (input, init) {
    if (init !== undefined) {
      await prepareOutgoingInit(init)
    }
    try {
      if (init !== undefined) {
        return await rawFetch(input, init)
      }
      return await rawFetch(input)
    } catch (err) {
      if (init === undefined || !isDuplexTypeError(err)) {
        throw err
      }
      const name = (err && err.name) || 'Error'
      const message = String((err && err.message) || err).slice(0, 180)
      const where = sanitizeUrl(typeof input === 'string' ? input : (input && input.url))
      console.warn('[jsproxy-yt-test] fetch fail', name, message, where)
      return new Response('jsproxy-yt-test fetch failed: ' + name + ':' + message, {
        status: 502,
        headers: {
          'content-type': 'text/plain;charset=utf-8',
          'access-control-expose-headers': '--jsproxy-test,--jsproxy-test-error,--s',
          '--jsproxy-test': '1',
          '--jsproxy-test-error': name + ':' + message,
          '--s': '502',
        },
      })
    }
  }
}
