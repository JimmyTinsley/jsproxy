/**
 * SW 侧 fetch 包装：在作者 bundle.c33e24c5.js 调用 fetch(proxyUrl, init)
 * 之前把 ReadableStream body 缓冲成 ArrayBuffer。
 *
 * 这是针对 Chrome 105+ 的构造期异常：
 *   TypeError: Failed to execute 'fetch' on 'WorkerGlobalScope':
 *   The 'duplex' member must be specified for a request with a streaming body
 *
 * 评估结论：只加 duplex half 能过构造检查，但对 /http/ 代理路径仍会
 * 因流式上传 CORS 预检失败。缓冲 body 后请求变为普通 POST，本地与
 * 用户 Worker 对照均已通过。本包装删除 duplex 字段，不以它为修复。
 *
 * 本文件既被测试引用，也被 worker.js 嵌入到 /sw.js（importScripts bundle 之前）。
 */

export function sanitizeUrl(u) {
  try {
    const x = new URL(typeof u === 'string' ? u : (u && u.url) || '')
    return x.origin + x.pathname
  } catch (err) {
    return '[unparseable-url]'
  }
}

/**
 * @param {RequestInit} init
 * @returns {Promise<RequestInit>}
 */
export async function prepareOutgoingInit(init) {
  const src = init || {}
  const out = {}
  const keys = Object.keys(src)
  for (let i = 0; i < keys.length; i++) {
    out[keys[i]] = src[keys[i]]
  }
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
  return out
}

export function installJsproxyYtTestFetchWrap(global) {
  const rawFetch = global.fetch.bind(global)

  global.fetch = async function (input, init) {
    try {
      if (init !== undefined) {
        const prepared = await prepareOutgoingInit(init)
        return await rawFetch(input, prepared)
      }
      return await rawFetch(input)
    } catch (err) {
      if (init === undefined) {
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
