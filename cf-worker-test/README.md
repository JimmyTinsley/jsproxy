# jsproxy YouTube 隔离测试 Worker

**这是隔离测试版，不是生产 `https://js.jimmytinsley.com`，也不承诺 YouTube 能播。**

生产 Worker、DNS、`master`、`gh-pages`、Pages 开关、生产 `ASSET_URL` 都不要动。在 Cloudflare 仪表盘 **新建** 一个 Worker，粘贴 [`worker.js`](./worker.js)。

## 这个测试版改了什么

已复现的根因：作者 `bundle.c33e24c5.js` 在 SW 里对 POST `ReadableStream` 调用 `fetch(url, init)` 且 **没有缓冲 / 没有 duplex**，Chrome 在请求出站前抛：

`TypeError: Failed to execute 'fetch' on 'WorkerGlobalScope': The 'duplex' member must be specified for a request with a streaming body`

随后 bundle 把失败收成 **200 text/html `load fail`**，看起来像成功。

本测试 Worker：

1. 自己下发新的 `/sw.js`（`conf.ver = 120`，`Cache-Control: no-store`），在 `importScripts` 作者 bundle **之前** 包装 `fetch`：把流 body `arrayBuffer()`；空流则变成无 body POST。
2. **不把只加 `duplex:'half'` 当充分方案**（`/http/` 上的流式 CORS 预检仍会 Failed to fetch）。
3. 包装器在带 init 的 fetch 失败时返回 **502** + `--jsproxy-test-error`，避免误导性 200。
4. 日志只保留 `origin+pathname`，丢掉 query（签名 / `n` / token）。
5. `static_boost` 关闭；`cors_v1.txt` 为空；节点只有 `mysite = location.host`。
6. `/http/` 只允许 YouTube/Google 播放相关公开域；作者静态文件经本 origin 反代 `etherdream.github.io/jsproxy`（bundle 字节未改，但 URL 是测试 origin）。

权衡：为了让播放器依赖的 `www.google.com` / `accounts.google.com` / `*.gstatic.com` 等能过，白名单包含 `*.google.com`。这比「仅 youtube.com」宽，但仍拒绝 `example.com`、社交媒体等任意站点，**不是无鉴权全球代理**。

## Dashboard 部署（你来操作）

1. 打开 Cloudflare Dashboard → Workers & Pages → **Create**（新建，不要改现有 `js.jimmytinsley.com` 那个）。
2. 把本目录 `worker.js`（或 `/opt/cursor/artifacts/worker.js`）全文粘贴进编辑器。
3. Save and deploy。
4. 绑定：无。环境变量：无。密钥：无。
5. compatibility_date：仪表盘默认即可；若强制填写，用 **`2024-11-11`**。
6. 记下 `https://<name>.<subdomain>.workers.dev`。

## 浏览器试播（你来操作）

1. 用 **未注册过生产 SW 的配置文件 / 隐私窗口** 打开测试 origin（不要用已经打开过 `js.jimmytinsley.com` 的同一配置，以免 SW 串缓存）。
2. 应先看到「隔离测试版 SW 安装中」，刷新后出现测试首页。
3. 打开 DevTools → Application → Service Workers，脚本应是测试 origin 的 `/sw.js`，内容含 `jsproxy-yt-test` 和 `prepareOutgoingInit`。
4. 自检：`/__test__/info` 应有 `"isolatedTest": true`、`"testVer": "120"`。
5. 首页默认链接是 `https://www.youtube.com/watch?v=jNQXAC9IVRw`，点打开。
6. 点播放时再看 **videoplayback**（不要看遥测）：不应再出现 SW 构造期 duplex TypeError；若媒体仍失败，应看到 **非 200** 或 `--jsproxy-test-error` / `--s`，而不是 `load fail` 的假 200 HTML。
7. 不要把测试结果理解成「YouTube 已修好」。

## 本地复现

```bash
node cf-worker-test/tests/run.mjs
```

覆盖：空/非空 ReadableStream 经 SW 转发不再 TypeError、GET、Range 206、OPTIONS 预检、非白名单 403。不请求签名媒体 URL。

## 文件

| 路径 | 作用 |
|---|---|
| `worker.js` | 可粘贴部署的单文件（隔离测试产物） |
| `build.mjs` | 把 `frontend/fetch-wrap.js` 嵌入 `worker.js` |
| `frontend/fetch-wrap.js` | 可维护的 SW fetch 包装源码 |
| `frontend/network.launch.js` | 若将来重建 bundle 的源码级补丁说明 |
| `tests/run.mjs` | 本地测试 |

构建：

```bash
node cf-worker-test/build.mjs
node cf-worker-test/tests/run.mjs
```

`tests/run.mjs` 会把 `worker.js` 复制到 `/opt/cursor/artifacts/worker.js` 并写出 sha256。单文件约 18KB，可直接 dashboard 粘贴。

当前产物（隔离测试版，**不是** YouTube 已能播的承诺）：

- 文件：`cf-worker-test/worker.js`（与 `/opt/cursor/artifacts/worker.js` 相同）
- sha256：`55b57efec51e37d2ac2f2f29149ee52daab92f6079e5270f10b8808adee624d9`
- 字节：18380
- compatibility_date 提示：`2024-11-11`（仪表盘默认即可）
- 绑定 / 环境变量 / 密钥：**无**

## 不可保证

- 未请求 YouTube 私有 API、完整签名媒体 URL，也没有绕过任何封禁。
- 未在 Cloudflare 上部署，未登录账号。真实 Chrome 试播由你完成。
- 白名单含 `*.google.com` 是播放器/账号域权衡，不是开放代理；非白名单返回 **403**，不会伪装成 200 HTML。
- 本仓库 `master` / `gh-pages` / 生产 Worker / DNS / Pages / 生产 `ASSET_URL` 都未改。
