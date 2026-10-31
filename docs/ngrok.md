# 用 ngrok 作为公网入口

Compose 内置 `ngrok` 服务，将公网 HTTPS 请求转发到同一网络中的 `bridge:8787`。
通过 `public` profile 开启；仅运行本机服务时不需要 ngrok token。

## 服务器配置

```bash
cd ~/workbuddy-subscription-bridge
git pull --ff-only
cp .env.example .env
chmod 600 .env
```

如果已经有 `.env`，直接编辑已有文件，不要覆盖它。填写：

```dotenv
COMPOSE_PROFILES=public
NGROK_AUTHTOKEN=你的_ngrok_agent_authtoken
NGROK_URL=
```

`NGROK_URL` 可选。如果账号已经有可用的固定 HTTPS 地址，可填写类似
`https://your-domain.ngrok.app` 的完整地址，以便 WorkBuddy 一直使用同一个入口。
留空时让 ngrok 选择地址，以本次日志中实际启动的 URL 为准。

`.env` 只在服务器保存，已被 Git 和 Docker 构建上下文排除。
ngrok token 只传给 ngrok 容器；WorkBuddy 仍填写桥接服务自己的 Key。

## 启动并查看地址

一键启动、触发浏览器登录，并在成功后自动输出四系列最新可用 WorkBuddy 模型配置数组：

```bash
sh start.sh
```

无桌面服务器先建立下文的 1455 回调转发，或直接使用 README 中的 SSH 一条命令。
脚本输出的数组包含 Astra、Sol、Terra、Luna 各系列在账号目录中最新可用的稳定版本，已填好公网 URL 和桥接 Key。将数组中的各个对象合并到 WorkBuddy 的模型列表。

以下命令用于手动启动和排错：

```bash
docker compose up -d --build --wait
docker compose ps
docker compose logs --tail=50 ngrok
```

Compose 自动读取 `.env` 中的 `COMPOSE_PROFILES=public`，同时启动桥接和 ngrok。
ngrok 等桥接健康检查通过后再启动。日志中 `started tunnel` 的 `url` 为公网地址，
也可以在 ngrok 控制台查看在线端点。服务与 ngrok 都使用 `restart: unless-stopped`。
`--wait` 确认容器启动；公网是否可访问还要按下面的方式检查。

如果在 shell 中设置了覆盖 `.env` 的环境变量，确保 `COMPOSE_PROFILES` 包含 `public`，
或显式使用 `docker compose --profile public up -d --build --wait`。

## 首次授权仍在部署电脑完成

```bash
docker compose exec bridge node src/cli.mjs login --host 0.0.0.0 --no-open
docker compose exec bridge node src/cli.mjs status
docker compose exec bridge node src/cli.mjs key
```

如果服务器没有浏览器，在自己的电脑建立只用于登录回调的 SSH 转发，再在本地
浏览器打开服务器打印的授权链接：

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:1455:127.0.0.1:1455 USER@REMOTE_HOST
```

登录命令必须保持运行直到回调完成。成功后可以关闭这个 SSH 转发，日常请求走
ngrok HTTPS 地址即可。完整登录流程见 [远程部署](远程部署.md)。

登录成功会自动打印 WorkBuddy 模型 JSON 数组。后续再次获取配置可执行：

```bash
sh config.sh
```

公网地址通过 ngrok agent 的 `/api/endpoints` 自动读取；4040 管理端口仅在 Docker
网络中可访问，没有发布到宿主机或经隧道转发。

ngrok 只转发 API 端口 8787，OAuth 回调端口 1455 继续仅绑定服务器回环地址。
服务本身不会通过 HTTP 提供登录、导入令牌或修改上游地址的入口。

## WorkBuddy 配置与验证

假设实际公网地址是 `https://your-domain.ngrok.app`：

| 项目 | 配置 |
| --- | --- |
| 完整接口地址 | `https://your-domain.ngrok.app/v1/chat/completions` |
| Base URL（客户端需要时） | `https://your-domain.ngrok.app/v1` |
| 模型 ID | `config.sh` 输出的 Astra、Sol、Terra、Luna 最新可用模型 ID |
| API Key | 服务器上 `node src/cli.mjs key` 命令输出的桥接 Key |
| 自定义协议、工具调用 | 开启 |

编辑 `~/.workbuddy/models.json` 时只更新桥接条目的 `url` 和 `apiKey`，保留其他模型。
四系列条目可参考 [配置示例](../examples/workbuddy-models.json)，具体版本以命令实时输出为准。

从另一台电脑检查公网可达性，不需要 Key：

```bash
curl --fail https://your-domain.ngrok.app/health
```

应返回桥接的健康 JSON。这个结果只证明网络可达。模型接口仍要求有效的
`Authorization: Bearer` 桥接 Key；先在 WorkBuddy 测试普通问答，再验证工具调用。

ngrok 的 Traffic Policy 将上游 Host 固定为 `127.0.0.1:8787`，符合桥接的 Host
校验。桥接继续拒绝浏览器 Origin，并保留本机密钥鉴权。agent 的 HTTP 请求检查
已通过 `--inspect=false` 关闭；此配置不改变 ngrok 账号侧的云端观测设置。

## 更新与停止

```bash
git pull --ff-only
docker compose up -d --build --wait
```

修改 ngrok token 或 `NGROK_URL` 后，重新执行 `up` 让 Compose 更新容器。
仅关闭公网入口并保留桥接运行：

```bash
docker compose --profile public stop ngrok
```

关闭本项目全部服务并保留账号卷：

```bash
docker compose --profile public down
```

如果不再需要公网入口，将 `.env` 的 `COMPOSE_PROFILES` 留空，再按本地或 SSH
方式使用。已有 ngrok 容器需要先用上面的 `stop` 或 `down` 停止。

官方参考：[Docker Compose](https://ngrok.com/docs/using-ngrok-with/docker/compose)、
[Agent CLI](https://ngrok.com/docs/gateway/agent/cli)、
[Host 重写示例](https://ngrok.com/docs/universal-gateway/examples/ollama)。
