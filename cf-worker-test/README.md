# jsproxy YouTube 隔离测试 Worker

**这是隔离测试版，不是生产 `https://js.jimmytinsley.com`，也不承诺 YouTube 能播。**

生产 Worker、DNS、`master`、`gh-pages`、Pages 开关、生产 `ASSET_URL` 都不要动。覆盖部署时只更新已有测试 Worker `jsproxy-yt-test-20261115`，粘贴本目录 [`worker.js`](./worker.js)。

当前 conf.ver：**121**（必须递增，已安装的测试 SW 才会换新脚本）。

## 这个测试版改了什么

已复现的根因：作者 `bundle.c33e24c5.js` 在 SW 里对 POST `ReadableStream` 调用 `fetch(url, init)`，Chrome 抛 duplex TypeError，随后合成误导性 **200** `text/html` `load fail`。

v121 相对 v120 的修正（针对真实 Chrome 回退：能打开 watch 页但无时长、video 无 src、无 videoplayback）：

1. 流 body **原地**写成 ArrayBuffer，写回同一个 `RequestInit`，让 `network.launch()` 重试能复用正文（之前只改副本，重试拿到已锁的空流）。
2. **不再**把带 init 的任意 fetch 失败收成 502。AbortError / `Failed to fetch` 重新抛出。只有 duplex TypeError 才返回 502 + `--jsproxy-test-error`（避免 bundle 的假 200）。
3. 首页去掉 `/__test__/info`、`/works` 链接：作者 SW 会把相对路径导航改成 `google.com/search?q=...`，从而进 Google/sorry。自检用 curl。
4. 白名单补 `youtube-nocookie.com`（YouTube 公开嵌入域）。**不把 doubleclick 403 当根因**，也不为广告域开放代理。

其它仍与 v120 相同：`static_boost` 关闭；`cors_v1.txt` 仍为空所以直连列表不生效（作者 cors 列表里也没有 youtube/gstatic，对播放器初始化差异很小）；节点只有 `mysite`；日志去敏。

## Dashboard 覆盖部署（你来操作）

1. 打开已有测试 Worker（不要动生产 `js.jimmytinsley.com`）。
2. 粘贴 `cf-worker-test/worker.js` 或 `/opt/cursor/artifacts/worker.js`。
3. Save and deploy。绑定 / 环境变量 / 密钥：**无**。compatibility_date：默认或 **`2024-11-11`**。
4. 用隐私窗口打开测试 origin，确认 `/sw.js` 含 `jsproxy-yt-test sw 121`，或 curl `/__test__/info` 的 `testVer` 为 `"121"`。

## 浏览器只读诊断（请先看这些，再判断能否播）

不要点页面上的相对路径自检，不要打开 Google/sorry 挑战。

终端：

```bash
curl -sS https://jsproxy-yt-test-20261115.jimmytinsley.workers.dev/__test__/info
```

应有 `"testVer": "121"`、`"wrapInPlaceBody": true`。

然后用隐私窗口打开：

`https://jsproxy-yt-test-20261115.jimmytinsley.workers.dev/-----https://www.youtube.com/watch?v=jNQXAC9IVRw`

DevTools：

1. **Document**：`watch?v=jNQXAC9IVRw` 的响应是否真是 YouTube HTML（能否搜到 `ytInitialPlayerResponse` / `lengthSeconds`），还是 302/312 去 `google.com/sorry`，或 `--error`。
2. **XHR/fetch**：是否出现 `youtubei/v1/player`（或 `/youtubei/`）POST；状态是 JSON 200 还是 502/403；请求头是否有 jsproxy 的 `Referer: /?--ver=121...`。
3. **Media**：点 Play 后是否出现 `videoplayback`；没有出现说明播放器数据阶段就停了，还没到媒体。
4. **Console**：是否还有 `duplex` TypeError；是否有 `JSON.parse` / `innertube` 类异常。accounts iframe CSP 与 accounts 401 生产同样有，不要当新根因。doubleclick 403 在本测试版仍预期（未放行广告域）。
5. **Elements**：`video` 的 `src` / `duration`。生产已知基线是能出现约 19 秒时长和 adaptiveFormats，再在媒体请求上因 duplex 挂；若 121 仍无时长，把上述 1–4 的有/无发回来。

## 本地复现

```bash
node cf-worker-test/build.mjs
node cf-worker-test/tests/run.mjs
```

覆盖：流 POST 缓冲与 **init 重用**、AbortError 再抛、GET/Range/预检/403、首页无自检链接。不请求签名媒体 URL，不走 Google sorry。

当前产物（隔离测试版，**不是** YouTube 已能播的承诺）：

- 文件：`cf-worker-test/worker.js`（与 `/opt/cursor/artifacts/worker.js` 相同）
- sha256：`7d19e16b2107b284b7d0053b20845422b5e80e7e9a5fcb2d3ecb3d86951e7d32`
- 字节：19321
- conf.ver / SW：`121`
- compatibility_date 提示：`2024-11-11`
- 绑定 / 环境变量 / 密钥：**无**

## 不可保证

- 未请求 YouTube 私有 API、完整签名媒体 URL，也没有绕过封禁。
- 本机对 `/http/https://www.youtube.com/watch?...` 的 curl 会遇到 Google sorry（生产 Worker 同样）；那不能代表你的浏览器会话。
- 白名单仍不是开放代理。广告域 403 是刻意边界。
- 覆盖部署后仍不承诺能播。
