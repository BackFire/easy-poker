# 本机部署

- 页面、游戏 API 和 WebSocket：`https://k.amoy.work/`（公网需要 `:61234` 时加端口）。
- nginx 站点：`/etc/nginx/sites-available/easy-poker`。
- API：`docker compose up -d`，本地监听 `127.0.0.1:18789`。
- 牌桌状态：`.wrangler/state/`，更新容器时保留此目录。
- AI：模型配置在仓库忽略的 `/opt/easy-poker/.dev.vars`（权限 `0600`）。当前 `AI_MODEL=deepseek-v4-flash`、`AI_API_URL=http://127.0.0.1:8787/chat/completions`、`AI_THINKING=disabled`；服务端使用本机 `gpt-model-proxy.service` 的模型路由与密钥。房主页面不再配置或保存模型密钥；首次进入牌桌会清理旧浏览器模型配置和 AI 玩家记录，并让旧 AI 起身，需重新添加 AI。
- 页面和牌桌 API 无需登录。`aiAction` 通过现有 `/api/cmd` 进入游戏服务，服务端核对牌桌密码、当前行动玩家和回合，且每回合只请求一次模型。
- 模型日志：`docker logs easy-poker-api`，搜索 `"event":"ai_model"`；`requestId` 可与页面错误对应。日志记录开始、成功、失败、耗时、HTTP 状态和 token 用量，不记录密钥、提示词、模型回复或手牌。

更新：`git fetch origin && git merge origin/main` 后执行 `docker compose run --rm --no-deps api npm ci`，再执行 `docker compose up -d --force-recreate`。先验证 `npm test`、nginx `-t`，再对外使用。
