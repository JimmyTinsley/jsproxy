# jsproxy YouTube 隔离测试 Worker

**这是隔离测试版，不是生产 `https://js.jimmytinsley.com`，也不承诺 YouTube 能播。修 homepage 语法 ≠ 能播。**

生产 Worker、DNS、`master`、`gh-pages`、Pages、生产 `ASSET_URL` 都不要动。只覆盖测试 Worker `jsproxy-yt-test-20261115`。

当前 conf.ver：**122**。

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

应有 `"testVer": "122"`、`"jsfilterPatch": "postMessage-call-only"`。`/sw.js` 含 `jsproxy-yt-test sw 122`。

隐私窗口打开 homepage：`.../-----https://www.youtube.com/`。看 Console 是否还出现 `Unexpected token '('`。黄字 manifest 跨源可忽略。不要点相对路径自检。

## 本地

```bash
node cf-worker-test/build.mjs
node cf-worker-test/tests/run.mjs
```

当前产物（隔离测试版）：

- `cf-worker-test/worker.js` = `/opt/cursor/artifacts/worker.js`
- sha256：`2dc2014a534bbcf8a0e2dca8300b0c4e051f0e89f56639e78981d3c2cee7828d`
- 20818 bytes · conf.ver **122**
- compatibility_date：`2024-11-11`；绑定/密钥：无

## 不可保证

- 未验证真实 kevlar 脚本 5756:156。
- 修 homepage 语法不等于能播，也不等于 watch 能过人机验证。
- 广告域仍 403。生产未改。
