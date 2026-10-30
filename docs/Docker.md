# Docker 启动与授权

另一台常开电脑或无桌面服务器的完整步骤见 [远程部署与持续运行](远程部署.md)。

在项目目录执行，要求 Docker 引擎和 Docker Compose 已运行。宿主机无需安装 Node.js，也无需提供 OpenAI API Key。本地模式无需 `.env`；需要公网访问时，按 [ngrok 公网入口](ngrok.md) 复制 `.env.example` 并填写 token。

```bash
cd ~/workbuddy-subscription-bridge
docker compose up -d --build --wait
curl http://127.0.0.1:8787/health
```

健康检查应返回 `{"status":"ok","service":"workbuddy-subscription-bridge"}`。这只表示桥接服务已启动；实际模型调用还需要以下账号授权。

## 授权自己的 ChatGPT 账号

```bash
docker compose exec bridge node src/cli.mjs login --host 0.0.0.0 --no-open
```

保持命令运行，在这台电脑的浏览器中打开终端打印的授权链接，登录自己的 ChatGPT 账号，并按页面提示授权套餐使用。完成后应显示 `connected: true` 和 `plan_usage_enabled: true`。不需要把账号密码或 OAuth 令牌发给任何人。
授权成功后会自动打印 WorkBuddy 模型 JSON，包含接口地址和本机桥接 Key；启用 ngrok
时会尝试使用实际公网地址。再次获取用 `docker compose exec -T bridge node src/cli.mjs connection`。

容器内监听 `0.0.0.0` 才能接收 Docker 转发；Compose 将服务端口 8787 和回调端口 1455 都仅发布到宿主机 `127.0.0.1`。回调地址仍为 `http://127.0.0.1:1455/auth/callback`，不要改成容器名称或 `localhost`。若回调端口被其他程序占用，需要将 Compose 中的回调端口两端及登录命令的 `--callback-port` 同时改为相同的新端口。

## 配置 WorkBuddy

```bash
docker compose exec bridge node src/cli.mjs status
docker compose exec bridge node src/cli.mjs models
docker compose exec bridge node src/cli.mjs key
```

在 WorkBuddy 的自定义模型中填写：

| 配置项 | 内容 |
| --- | --- |
| 完整接口地址 | `http://127.0.0.1:8787/v1/chat/completions` |
| API Key | 上面 `key` 命令输出的桥接本机密钥 |
| 模型名称 | 上面 `models` 输出的一个 `slug` |
| 自定义协议、工具调用 | 开启 |

如果客户端需要 Base URL，填 `http://127.0.0.1:8787/v1`。在对话中明确选择此自定义模型。具体账号资格和模型调用能否成功，需真实授权后验收。

如果 WorkBuddy 已有直连的 `gpt-6.1-sol`，新增桥接条目时可用独立 ID
`gpt-6.1-sol-bridge`、名称 `GPT-6.1 Sol（本地订阅桥接）`。桥接会将这个 ID
映射到上游 `gpt-6.1-sol`，从而保留原模型配置。`models.json` 中使用
`api: "openai-completions"`、完整接口地址和 `useCustomProtocol: true`；
`apiKey` 填桥接的本机密钥。

可选的一次真实调用验证（会产生用量；将 `YOUR_MODEL_SLUG` 替换为实际值）：

```bash
docker compose exec bridge node src/cli.mjs verify --model YOUR_MODEL_SLUG
```

之后按 [使用教程](使用教程.md) 完成普通问答、只读工具调用及 ChatGPT 用量页核对。

## 数据与日常操作

密钥、客户端注册及 OAuth 令牌保存在 Docker 命名卷 `workbuddy-subscription-bridge_bridge-data` 中，容器内路径 `/app/.local`。镜像只包含运行代码，不包含宿主机 `.local`。Docker 数据和直接用 Node 运行时的项目 `.local/` 各自独立。

```bash
docker compose ps
docker compose logs --tail=50 bridge
docker compose restart bridge
docker compose down
```

`down` 保留登录数据，下次执行 `docker compose up -d` 继续使用；`docker compose down -v` 会删除登录数据和本机密钥。退出账号用：

```bash
docker compose exec bridge node src/cli.mjs logout
```

容器退出后由 Docker 自动重启，手动停止后保持停止。电脑重启后需确保 OrbStack / Docker 自动启动。

## 容器内回归测试

测试使用临时目录和合成凭据，通过本地 HTTP 模拟上游，不使用已登录账号：

```bash
docker run --rm --network none \
  --mount "type=bind,source=$PWD/test,target=/app/test,readonly" \
  --entrypoint node workbuddy-subscription-bridge:local \
  --test test/auth.test.mjs test/bridge.test.mjs
```
