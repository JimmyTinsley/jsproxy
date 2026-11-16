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

1. **主修复**：`fetch-wrap.js` 在 SW 里包装 `fetch`，流 body → `arrayBuffer()` 并 **写回同一 init**（`network.launch()` 最多重试 5 次，不能只改副本）。空流则省略 body。不把 duplex half 当充分方案。
2. **诊断**：仅 duplex TypeError 返回 **502** + `--jsproxy-test-error`。AbortError / 普通 Failed to fetch **必须再抛**，否则播放器会把 502 文本当成 innertube JSON。
3. **日志**：只打 `origin + pathname`，丢掉 query（签名/`n`/token）。
4. **jsfilter**：作者 `jsfilter.parseStr` 用 `/postMessage\s*\(/` 改所有 script。对 `function postMessage(` / 方法简写会变成非法形参，V8 报 `SyntaxError: Unexpected token '('`。测试 Worker 在提供 `bundle.c33e24c5.js` 时把该正则收窄为 `/\.postMessage\s*\(/`（只改成员调用）。源码见 `jsfilter.js`。
5. 未拿到用户截图里那份截断名 `kevlar_base_module…sync_mod_chunk` 的原始字节，因此不能声称已核对 5756:156；能核对的是同一改写规则的最小 case 与作者 bundle 中的唯一改写点。
6. **v124** 不改本文件。白名单取消在 `worker.js` 的目的地检查里；不要把 v123 的 `x-jsproxy-reqmap` 嵌进 v124 Worker。

若以后要重建 bundle，等价源码补丁见 `network.launch.js`。

嵌入到可粘贴 Worker：

```bash
node cf-worker-test/build.mjs
```

会把本文件写入 `worker.js` 的 `FETCH_WRAP_IIFE`（`/sw.js` 在 `importScripts` bundle 之前执行）。
