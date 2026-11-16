/**
 * 若以后用 webpack 4 重建 EtherDream/jsproxy-browser bundle，
 * 这是 `src/proxy/src/network.js` `launch()` 里 POST body 段的等价最小补丁。
 * 当前测试 Worker 不依赖这次重建：SW fetch-wrap 已覆盖同一路径。
 *
 * 原代码（a7a6d74 network.js:200-209）：
 *
 *   if (method === 'POST' && !req.bodyUsed) {
 *     if (req.body) {
 *       reqOpt.body = req.body
 *     } else {
 *       const buf = await req.arrayBuffer()
 *       if (buf.byteLength > 0) {
 *         reqOpt.body = buf
 *       }
 *     }
 *   }
 */

export async function assignBufferedBody(req, reqOpt) {
  const method = req.method
  if (method === 'GET' || method === 'HEAD' || req.bodyUsed) {
    return
  }
  const buf = await req.arrayBuffer()
  if (buf.byteLength > 0) {
    reqOpt.body = buf
  }
}
