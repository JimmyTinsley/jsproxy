# 隔离测试版前端补丁（源码对照）

这不是生产 `gh-pages` / `bundle.c33e24c5.js` 的替换目录。线上测试 Worker 在 **importScripts 作者 bundle 之前** 安装 `fetch-wrap.js`，从而不必改压缩包即可消除 SW 流式 POST 构造 TypeError。

## 上游落点

| 问题 | 上游文件 | 行号 |
|---|---|---|
| POST 把 `ReadableStream` 原样塞进 init，无 buffering / duplex | [EtherDream/jsproxy-browser `src/proxy/src/network.js`](https://github.com/EtherDream/jsproxy-browser/blob/a7a6d740e2c64b1a029fe9ced8ffe9f786e154dd/src/proxy/src/network.js) `launch()` | 200–209, 272–281 |
| `launch()` 失败返回 `undefined` | 同上 | 299–301 |
| SW 合成 **200** `text/html` `load fail` | [`src/proxy/src/sw.js`](https://github.com/EtherDream/jsproxy-browser/blob/a7a6d740e2c64b1a029fe9ced8ffe9f786e154dd/src/proxy/src/sw.js) `forward()` / `makeHtmlRes` | 87–96, 273–275 |
| 生产入口 | `www/sw.js` → `bundle.c33e24c5.js` | hash 入口 |

## 本测试版策略

1. **主修复**：`fetch-wrap.js` 在 SW 里包装 `fetch`，流 body → `arrayBuffer()`，空流则省略 body。不把 `duplex:'half'` 当充分方案。
2. **诊断**：包装器在带 init 的 fetch 失败时返回 **502** + `--jsproxy-test-error`（不用 `--error`，以免触发 bundle 里 cfworker 重试循环），避免误导性 200 `load fail`。
3. **日志**：只打 `origin + pathname`，丢掉 query（签名/`n`/token）。
4. **未改作者 bundle 字节**：由测试 origin 提供 `/assets/bundle.c33e24c5.js`（Worker 反代 etherdream.github.io），SW 脚本本身是新的。

若以后要重建 bundle，等价源码补丁见 `network.launch.js`。

嵌入到可粘贴 Worker：

```bash
node cf-worker-test/build.mjs
```

会把本文件写入 `worker.js` 的 `FETCH_WRAP_IIFE`（`/sw.js` 在 `importScripts` bundle 之前执行）。
