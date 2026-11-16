/**
 * 作者 bundle `network.js` `getResInfo()` 的契约副本
 * （EtherDream/jsproxy-browser a7a6d740 network.js:148-206）。
 *
 * SW 靠 `--set-cookie` 或 `N-set-cookie` 还原上游 Set-Cookie。
 * `Headers.set('--set-cookie', v)` 会丢掉其余 cookie；nginx lua 用
 * `1-set-cookie` … `N-set-cookie`，本函数两种都能解析。
 */

export function getResInfo(res) {
  const rawHeaders = res.headers
  let status = res.status
  const cookieStrArr = []
  const headers = new Headers()

  rawHeaders.forEach((val, key) => {
    if (key === 'access-control-allow-origin' || key === 'access-control-expose-headers') {
      return
    }
    if (key === '--s') {
      status = +val
      return
    }
    if (key === '--t') {
      return
    }
    const m = key.match(/^\d+-(.+)/)
    if (m) {
      key = m[1]
      if (key === 'set-cookie') {
        cookieStrArr.push(val)
      } else {
        headers.append(key, val)
      }
      return
    }
    if (key.startsWith('--')) {
      key = key.substr(2)
    }
    if (key === 'set-cookie') {
      cookieStrArr.push(val)
      return
    }
    headers.set(key, val)
  })

  return { status, headers, cookieStrArr }
}
