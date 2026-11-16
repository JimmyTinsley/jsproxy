# v123 单独产物（未随 v124 部署）

这是 Cookie 编号 / `x-jsproxy-reqmap` 实验，**没有**打进 v124 测试 Worker。

- `worker.v123.js` sha256 `d3ab8f1abd855dfd0bae582a78d98457cc2fa3998cc376478c075a6fcce7e6f7`
- 回归：`node cf-worker-test/archive-v123/run-v123.mjs` 前需把该文件当作 worker（该脚本仍读 `../worker.js`；需要时自行 `cp worker.v123.js ../worker.js` 会覆盖 v124，不要在部署 v124 时这样做）。

离线 zip 仍在 `/opt/cursor/artifacts/jsproxy-yt-test-v123-offline.zip`。
