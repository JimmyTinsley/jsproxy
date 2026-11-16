jsproxy 隔离测试 Worker · 离线浏览器回归（v123 Cookie 实验，不是 v124）
=====================================================

这不是生产 https://js.jimmytinsley.com。不承诺 YouTube 能播。
修多 Set-Cookie / Referer 头还原 ≠ 过人机门。不要对真实 ServiceLogin 401 URL 重试。

v124 可部署 Worker 是上级目录 `../worker.js`（无 Cookie/reqmap）。本 harness 仍针对 v123。

  cp ../archive-v123/worker.v123.js ./worker.js
  node server.mjs

然后用 Chrome 打开终端打印的地址（默认 http://127.0.0.1:8793/）。
页面会自动跑合成数据回归，并把 PASS/FAIL 画在页面上。把整页结果复制发回即可。

本服务器：
- 加载同目录 worker.js（隔离测试 Worker）
- 把 youtube.com / google.com 的上游请求拦到合成 fixture（无真实 Cookie、不登录、不拉签名媒体）
- 不访问 accounts.google.com 的真实 ServiceLogin，不打开 sorry / 机器人挑战

可选：无浏览器，只跑服务端契约：

  node server.mjs --self-test
