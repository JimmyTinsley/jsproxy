/**
 * 作者 bundle 里对所有 script 做的字符串改写（EtherDream jsproxy-browser jsfilter.js）。
 * 线上 minified 等价于：
 *   a.replace(/(\b)location(\b)/g, ...)
 *    .replace(/postMessage\s*\(/g, s => s + `...(self.__set_srcWin?__set_srcWin():[]), `)
 *
 * `/postMessage\s*\(/` 会改到函数/方法定义，变成非法形参
 *   function postMessage(...(expr), x)
 * Chrome/V8 报 SyntaxError: Unexpected token '('
 *
 * 测试版只把调用点 `.postMessage(` 改写，定义保持原样。
 */

export const UPSTREAM_POSTMESSAGE_SITE = '.replace(/postMessage\\s*\\(/g,'
export const PATCHED_POSTMESSAGE_SITE = '.replace(/\\.postMessage\\s*\\(/g,'

export function parseStrUpstream(code) {
  let match = false
  code = code.replace(/(\b)location(\b)/g, (_, $1, $2) => {
    match = true
    return $1 + '__location' + $2
  })
  code = code.replace(/postMessage\s*\(/g, (s) => {
    match = true
    return s + `...(self.__set_srcWin?__set_srcWin():[]), `
  })
  return match ? code : null
}

export function parseStrFixed(code) {
  let match = false
  code = code.replace(/(\b)location(\b)/g, (_, $1, $2) => {
    match = true
    return $1 + '__location' + $2
  })
  code = code.replace(/\.postMessage\s*\(/g, (s) => {
    match = true
    return s + `...(self.__set_srcWin?__set_srcWin():[]), `
  })
  return match ? code : null
}

export function patchAuthorBundle(text) {
  const src = String(text)
  let n = 0
  let pos = 0
  while ((pos = src.indexOf(UPSTREAM_POSTMESSAGE_SITE, pos)) !== -1) {
    n++
    pos += UPSTREAM_POSTMESSAGE_SITE.length
  }
  if (n !== 1) {
    throw new Error('jsfilter postMessage rewrite site count=' + n)
  }
  return src.replace(UPSTREAM_POSTMESSAGE_SITE, PATCHED_POSTMESSAGE_SITE)
}
