# jsproxy 隔离测试 Worker

**这是隔离测试版，不是生产 `https://js.jimmytinsley.com`。** v124 起不再是 YouTube 专用白名单，可代理普通公开 http(s) 网站；仍拒绝 localhost / 私网 / metadata 字面目的地。不承诺任意站点能完整运行，也不做人机/登录绕过。

生产 Worker、DNS、`master`、`gh-pages`、Pages、生产 `ASSET_URL` 都不要动。只覆盖测试 Worker `jsproxy-yt-test-20261115`。

当前 conf.ver：**124**（基于线上 **v122**：SW 流式 POST 缓冲 + jsfilter `postMessage` 修补）。**不含 v123** 的 Cookie/reqmap 改动（v123 单独见 `archive-v123/`）。

## v124：取消 YouTube/Google 白名单

相对已部署的 v122，只做这些：

1. 删除 `ALLOWED_HOST_SUFFIXES`（youtube.com / google.com 等）。`example.com` 等公开站可走 `/http/`。
2. 增加字面目的地拒绝（**不 DNS、不连内网**）：`localhost`、`*.localhost` / `*.local` / `*.internal`、`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`（含 metadata）、`100.64/10`、`::1`、link-local/ULA IPv6、`metadata.google.internal`。
3. 文案与 `/__test__/info` 标记：`youtubeAllowlist: false`、`publicHttpsProxy: true`。首页默认 `https://example.com/`。
4. `TEST_VER = '124'`，bundle 查询 `?jsproxy-yt-test=124` 防缓存。
5. 保留 v122 的 fetch-wrap 缓冲与 jsfilter `.postMessage(` 修补。协议仍只允许 `http:` / `https:`。

不要打开 Google 登录/验证码路径做核验。

## 覆盖部署

粘贴 `cf-worker-test/worker.js` 或 `/opt/cursor/artifacts/worker.js`。绑定/变量/密钥：无。compatibility_date：默认或 `2024-11-11`。

```bash
curl -sS https://jsproxy-yt-test-20261115.jimmytinsley.workers.dev/__test__/info
# 应有 "testVer": "124"、"youtubeAllowlist": false、"publicHttpsProxy": true

# 公开站（部署后由你 curl）
curl -sS -D- "https://jsproxy-yt-test-20261115.jimmytinsley.workers.dev/http/https://example.com/" | head

# 私网应 403，且 Worker 在 fetch 之前拒绝
curl -sS -D- "https://jsproxy-yt-test-20261115.jimmytinsley.workers.dev/http/https://127.0.0.1/"
```

隐私窗口打开 `.../-----https://example.com/`。不要点相对路径自检。不要走 accounts.google.com / sorry。

## 本地

```bash
node cf-worker-test/build.mjs
node cf-worker-test/tests/run.mjs
```

当前产物（隔离测试版 v124）：

- `cf-worker-test/worker.js` = `/opt/cursor/artifacts/worker.js`
- sha256：`796c8b8c4d267ea87e2c3a3bc8b8e96aa7cc98d925d0407403dbfcbeb1e3e572`
- 22404 bytes · conf.ver **124**
- compatibility_date：`2024-11-11`；绑定/密钥：无

v123 单独产物（未部署，勿与 v124 捆绑）：`cf-worker-test/archive-v123/worker.v123.js` 与 `/opt/cursor/artifacts/worker-v123.js`（sha256 `d3ab8f1abd855dfd0bae582a78d98457cc2fa3998cc376478c075a6fcce7e6f7`）。

## 不可保证

- 任意站点 JS/Cookie/登录都能在在线代理里工作。
- YouTube 能播或过人机验证。
- 未做 DNS 解析型 SSRF 防护（按要求不解析真实内网）。
- 广告域不再被 YouTube 白名单挡住（它们若是公开 https 可被代理）。
- 生产未改。
