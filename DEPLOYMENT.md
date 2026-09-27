# 本机部署

- 页面、游戏 API 和 WebSocket：`https://k.amoy.work/`（公网需要 `:61234` 时加端口）。
- nginx 站点：`/etc/nginx/sites-available/easy-poker`。
- API：`docker compose up -d`，本地监听 `127.0.0.1:18789`。
- 牌桌状态：`.wrangler/state/`，更新容器时保留此目录。
- AI：浏览器「AI玩家」内预置「本机 DeepSeek」配置，模型 `deepseek-v4-flash`；nginx 将 `/ai/v1/responses` 和 `/ai/v1/chat/completions` 转发至本机模型代理。预置模型直接使用 Chat Completions，其他模型的 Responses 请求不支持时自动回退。房主首次使用时在「管理模型配置 → 本机 DeepSeek → 配置 Token」填写 AI Token，浏览器会加密保存；已有浏览器配置刷新后沿用原 Token。
- 页面和牌桌 API 无需登录；仅 `/ai/v1/responses` 与 `/ai/v1/chat/completions` 校验 Bearer Token。服务端 Token 在 `/etc/nginx/snippets/easy-poker-ai-token.conf`，仅 root 可读。

更新：`git fetch origin && git merge origin/main` 后执行 `docker compose run --rm --no-deps api npm ci`，再执行 `docker compose up -d --force-recreate`。先验证 `npm test`、nginx `-t`，再对外使用。
