# jsproxy YouTube 隔离测试 Worker

**这是隔离测试版，不是生产 `https://js.jimmytinsley.com`，也不承诺 YouTube 能播。修 homepage 语法 ≠ 能播。**

生产 Worker、DNS、`master`、`gh-pages`、Pages、生产 `ASSET_URL` 都不要动。只覆盖测试 Worker `jsproxy-yt-test-20261115`。

当前 conf.ver：**123**。

## v123：多 Set-Cookie、Referer 4KB 边界、Origin/continue 实证

v122 首页壳能出来之后，播放器「Sign in to confirm you're not a bot」和 Google 401 仍在。**人机门不在本版范围，修 Cookie ≠ 能播。** 本版只修可用合成数据证实的通用代理缺陷：

1. **多 Set-Cookie**：v122 `Headers.set('--set-cookie')` 只留最后一枚。对齐 nginx lua，多枚编成 `1-set-cookie` … `N-set-cookie`，作者 bundle `getResInfo` 本来就能解析。
2. **Referer 长度**：Chrome ≥77 把 >4096 字节 Referer 收成 origin。SW wrap 把 bundle 的 referrer query 另拷到 `x-jsproxy-reqmap`；Worker 优先读这个头。不改 Origin 语义、不合成 UA/指纹。
3. **hop 头**：丢掉 SW→Worker 的 `sec-fetch-*` / `cf-*` / 站点 Cookie，避免把 same-origin hop 元数据交给上游。UA 只透传浏览器打到 Worker 的那份。
4. **continue**：编码后的 `continue=https://www.youtube.com/...` 经 Worker URL 重建后 host 仍是 youtube.com。**不会**把已经编成代理 URL 的 continue 改回 YouTube（避免伪造回跳）。

离线浏览器回归（可复制到另一台电脑，不必 clone 仓库）：

```bash
# 解压产物后：
node server.mjs
# 打开 http://127.0.0.1:8793/
```

仓库内：

```bash
node cf-worker-test/build.mjs
node cf-worker-test/tests/run.mjs
node cf-worker-test/offline-harness/server.mjs --self-test
```

## v122：homepage `SyntaxError: Unexpected token '('`

用户在 `.../-----https://www.youtube.com/` 灰骨架，Console 红错为

`Uncaught SyntaxError: Unexpected token '(' (at m=kevlar_base_module…sync_mod_chunk:5756:156)`

token 已确认为左括号 `(`，不是 `<`。脚本名中间截断，**没有完整 URL**。

诊断机制（不猜测完整 URL、不打开 Google 挑战、不拉签名媒体）：

1. 作者 `bundle.c33e24c5.js` 对 **所有** `script` 做 `jsfilter.parseStr`：`/postMessage\s*\(/` 后面插入 `...(self.__set_srcWin?__set_srcWin():[]), `。
2. 离线最小 case：`function postMessage(x){return x}` 与 `{postMessage(x){return x}}` **原文可 parse**；按作者规则改写后变成 `function postMessage(...(expr), x)`，Node/Chrome 均为 **`SyntaxError: Unexpected token '('`**。`location` 改写不会产生这个 token。
3. 收窄为 `/\.postMessage\s*\(/` 后，定义保持合法，成员调用仍注入。作者 bundle 里该 replace **恰好一处**，测试 Worker 提供 bundle 时打补丁，`?jsproxy-yt-test=122` 避免旧 SW 缓存。

**未拿到** 截图中那份 `kevlar_base_module…sync_mod_chunk` 原始字节（禁止再请求 youtube.com 以免触发/重试 sorry），所以 **不能声称已核对 5756:156**。能核对的是：同一改写规则确实会把合法现代方法/函数定义打成用户看到的那类 SyntaxError。

watch 页 Google unusual traffic 是独立阻塞，本版不处理、不绕过。

## 覆盖部署

粘贴 `cf-worker-test/worker.js` 或 `/opt/cursor/artifacts/worker.js`。绑定/变量/密钥：无。compatibility_date：默认或 `2024-11-11`。

```bash
curl -sS https://jsproxy-yt-test-20261115.jimmytinsley.workers.dev/__test__/info
```

应有 `"testVer": "123"`、`"jsfilterPatch": "postMessage-call-only"`、`"multiCookieNumbered": true`。`/sw.js` 含 `jsproxy-yt-test sw 123`。覆盖前可先 `curl -sS .../__test__/compat` 看 `"pass": true`。

隐私窗口打开 homepage：`.../-----https://www.youtube.com/`。看 Console 是否还出现 `Unexpected token '('`。黄字 manifest 跨源可忽略。不要点相对路径自检。

## 本地

```bash
node cf-worker-test/build.mjs
node cf-worker-test/tests/run.mjs
```

当前产物（隔离测试版）：

- `cf-worker-test/worker.js` = `/opt/cursor/artifacts/worker.js`
- sha256：`d3ab8f1abd855dfd0bae582a78d98457cc2fa3998cc376478c075a6fcce7e6f7`
- 30401 bytes · conf.ver **123**
- compatibility_date：`2024-11-11`；绑定/密钥：无
- 离线 zip：`/opt/cursor/artifacts/jsproxy-yt-test-v123-offline.zip`

## 不可保证

- 未验证真实 kevlar 脚本 5756:156。
- 修 homepage 语法 / 多 Cookie / Referer 不等于能播，也不等于 watch 能过人机验证。
- 未重试真实 ServiceLogin 401，未验证 Google 是否仍 401。
- 广告域仍 403。生产未改。
