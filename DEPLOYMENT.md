# 本机部署

- 页面、游戏 API 和 WebSocket：`https://k.amoy.work/`（公网需要 `:61234` 时加端口）。
- nginx 站点：`/etc/nginx/sites-available/easy-poker`。
- API：`docker compose up -d`，本地监听 `127.0.0.1:18789`。
- 牌桌状态：`.wrangler/state/`，更新容器时保留此目录。
- AI：浏览器「AI玩家」内预置「本机 Codex」配置，模型 `gpt-6-luna`；nginx 将 `/ai/v1/responses` 转发至本机 Codex router。
- 访问认证：nginx Basic Auth，哈希在 `auth.htpasswd`；管理员凭据单独保管。

更新：`git fetch origin && git merge origin/main` 后执行 `docker compose run --rm --no-deps api npm ci`，再执行 `docker compose up -d --force-recreate`。先验证 `npm test`、nginx `-t`，再对外使用。
