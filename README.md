# WorkBuddy 本地订阅桥接原型

首次安装请按 [从零执行与 WorkBuddy 使用教程](docs/使用教程.md) 操作。
教程以 `~/workbuddy-subscription-bridge` 为示例目录，包含终端命令、客户端配置、验收和排错。
使用 Docker 可直接按 [Docker 启动与授权](docs/Docker.md) 操作，宿主机无需安装 Node.js。
迁移到另一台常开电脑，请按 [远程部署与持续运行](docs/远程部署.md) 操作。
需要公网 HTTPS 地址，可启用 Compose 的 [ngrok 服务](docs/ngrok.md)，在服务器 `.env` 中填写 `NGROK_AUTHTOKEN`。

## 服务器一键部署、登录并获取 WorkBuddy 配置

服务器需要已安装并启动 Docker，支持 `docker compose`。先获取代码并配置 `.env`：

```bash
git clone https://github.com/zyileven/workbuddy-subscription-bridge.git ~/workbuddy-subscription-bridge
cd ~/workbuddy-subscription-bridge
cp .env.example .env
chmod 600 .env
```

已有仓库时用 `git pull --ff-only` 更新；已有 `.env` 时保留并编辑原文件。填写：

```dotenv
COMPOSE_PROFILES=public
NGROK_AUTHTOKEN=你的_ngrok_agent_authtoken
NGROK_URL=
```

`NGROK_URL` 可选，可以填写账号下可用的完整 HTTPS 地址；留空会自动读取 ngrok
启动后的公网地址。ngrok token 只在服务器 `.env` 保存。

如果**服务器本身能打开浏览器**，在服务器执行：

```bash
sh start.sh
```

如果是**无桌面的远程服务器**，在有浏览器的电脑执行以下一条命令，替换
`USER@REMOTE_HOST`。它同时建立登录回调转发并在服务器运行脚本：

```bash
ssh -L 127.0.0.1:1455:127.0.0.1:1455 USER@REMOTE_HOST \
  'cd ~/workbuddy-subscription-bridge && sh start.sh'
```

脚本会构建并启动桥接和 ngrok、打印登录链接。保持终端运行，在浏览器打开链接，
登录 ChatGPT 并授权套餐使用。回调仍为 `http://127.0.0.1:1455/auth/callback`。
登录成功后会自动读取公网地址、桥接 Key 和当前账号的模型目录，按 Astra、Sol、Terra、Luna
的顺序，输出每个系列最新可用稳定版本的 **JSON 数组**。版本按数字比较，例如 `6.10`
高于 `6.9`，不会固定在代码中的某一代版本。账号目录中不可见的系列不会被编造出来，
终端会提示缺少哪些系列。

每个模型的 `reasoning.supportedEfforts` 和 `defaultEffort` 也直接读取 OpenAI 返回的
`supported_reasoning_levels`、`default_reasoning_level`，不统一写死档位。支持 `ultra`
的模型会保留 `ultra`；不支持的模型不会增加该选项。关闭思考也只在目录列出 `none`
时开启。目录缺少这些能力字段时会明确报错，避免输出与真实模型不一致的列表。

输出结构如下（这里只展示核心字段；实际输出也包含工具、图片和思考设置）：

```json
[
  {
    "id": "gpt-6-astra-bridge",
    "name": "GPT-6 Astra（订阅桥接）",
    "vendor": "Custom",
    "provider": "openai",
    "api": "openai-completions",
    "url": "https://你的实际公网地址/v1/chat/completions",
    "apiKey": "脚本自动填入真实桥接Key",
    "supportsToolCall": true,
    "useCustomProtocol": true
  },
  {
    "id": "gpt-6.1-sol-bridge",
    "name": "GPT-6.1 Sol（订阅桥接）",
    "vendor": "Custom",
    "provider": "openai",
    "api": "openai-completions",
    "url": "https://你的实际公网地址/v1/chat/completions",
    "apiKey": "脚本自动填入真实桥接Key",
    "supportsToolCall": true,
    "useCustomProtocol": true
  },
  {
    "id": "gpt-6.1-terra-bridge",
    "name": "GPT-6.1 Terra（订阅桥接）",
    "vendor": "Custom",
    "provider": "openai",
    "api": "openai-completions",
    "url": "https://你的实际公网地址/v1/chat/completions",
    "apiKey": "脚本自动填入真实桥接Key",
    "supportsToolCall": true,
    "useCustomProtocol": true
  },
  {
    "id": "gpt-6-luna-bridge",
    "name": "GPT-6 Luna（订阅桥接）",
    "vendor": "Custom",
    "provider": "openai",
    "api": "openai-completions",
    "url": "https://你的实际公网地址/v1/chat/completions",
    "apiKey": "脚本自动填入真实桥接Key",
    "supportsToolCall": true,
    "useCustomProtocol": true
  }
]
```

示例版本仅用于说明格式，**以终端根据账号目录实时输出的结果为准**。
完整留空 Key 的示例见 [四系列配置示例](examples/workbuddy-models.json)。

将终端输出的数组中的各个对象，合并到 WorkBuddy 所在电脑的 `~/.workbuddy/models.json`
数组中，保留其他模型，避免嵌套数组。已有同 ID 的桥接条目则更新该条目。
然后在 WorkBuddy 中选择对应系列的订阅桥接模型。已有会话若未加载新配置，完全退出
并重新打开 WorkBuddy 后再选模型。首次登录完成后可以关闭 SSH，日常通过 ngrok 访问。

已经登录过、只想再次获取同一段配置时，在服务器执行：

```bash
sh config.sh
```

这个命令不重新登录、不发推理请求，会重新查询账号目录并输出四系列配置及桥接 Key。ngrok 尚未上线时
会明确报错并保留登录数据，修好 `.env` 或网络后重新获取即可。

已经部署旧版的服务器可以保留 `.env` 和登录数据，执行以下命令更新并获取四系列配置：

```bash
git pull --ff-only
sh config.sh --update
```

`--update` 会先重建服务容器并继续使用原来的登录数据和 Key，再输出配置，不走浏览器登录。
更新后日常只需记住 `sh config.sh`；首次部署和登录仍使用 `sh start.sh`。

详细维护步骤见 [ngrok 公网入口](docs/ngrok.md) 和 [远程部署](docs/远程部署.md)。

让 WorkBuddy 向本机发送 Chat Completions 请求，由本机服务完成官方
Sign in with ChatGPT 授权，再向公开的 OpenAI Responses API 发起请求。

```text
WorkBuddy（主模型、工具执行、文件权限）
  → http://127.0.0.1:8787/v1/chat/completions（本机密钥）
  → 本地桥接：协议转换、OAuth、令牌刷新
  → https://api.openai.com/v1/responses（套餐授权访问令牌）
```

这是个人本地集成原型。代码使用官方公开接入流程，不复用 Codex 客户端 ID、
不读取其他应用的凭据、不连接 ChatGPT backend-api。它不代表腾讯或 OpenAI
已认证此组合。真实账号资格、可用模型、套餐扣减与 WorkBuddy 客户端兼容性，
需要下面的真实验收；本地模拟测试不能证明这些。

## 1. 环境和目录

需要 Node.js 22 或以上。运行 `node --version` 确认。只用 Node 标准库，**不用 npm install**。
在本目录打开终端；以下所有命令均从此目录运行。

```bash
node src/cli.mjs init
node src/cli.mjs login
```

第二条会打开系统浏览器。在 OpenAI 页面检查应用名
`WorkBuddy Local Subscription Bridge`、账号和工作区，并授权使用 ChatGPT 套餐。
默认本地回调为 `http://127.0.0.1:1455/auth/callback`。
不要将 localhost 替换进回调地址。端口被占用时：

```bash
node src/cli.mjs login --callback-port 1456
```

每次登录可以换可用端口，但回调的协议、主机和路径保持不变。
无自动打开浏览器的环境可以用 `login --no-open`；终端中的授权 URL 应只在自己的设备上使用。

首次登录动态注册客户端，服务保存 OpenAI 签发的 client ID，后续登录和刷新复用它。
身份登录成功但未授予 `chatgpt.tokens.use.direct` 时，服务会显示
`plan_usage_enabled: false` 并阻止模型请求。

## 2. 选择账号实际可用的模型

```bash
node src/cli.mjs status
node src/cli.mjs models
```

从 `models` 输出复制一个 `slug`。不要猜模型名称，也不要把 API 平台中的模型名
直接当作订阅一定可用的模型。模型目录可见不代表推理已获准。

可先执行一次小请求验收，它会产生真实用量：

```bash
node src/cli.mjs verify --model YOUR_MODEL_SLUG
```

将 `YOUR_MODEL_SLUG` 替换为上一步取得的值。收到 `response.completed` 只证明
该请求完成；具体计入哪项套餐/额度，应在 ChatGPT 设置 → 用量中核对。
不能据此承诺获得 Codex 客户端的全部权益。

## 3. 启动本地服务

```bash
node src/cli.mjs serve
```

保持这个终端运行；Ctrl+C 停止服务。默认监听 `127.0.0.1:8787`，不会监听局域网。
另开一个终端，在同一目录执行：

```bash
node src/cli.mjs key
```

它只打印桥接服务自己的随机本机密钥。**WorkBuddy 填这个密钥，不填写 OpenAI
access token、refresh token 或 ChatGPT 密码。** OAuth 令牌留在本地桥接服务中。

## 4. 在 WorkBuddy 中配置主模型

进入 设置 → 模型 → 添加模型 → 自定义，填写：

| 配置项 | 内容 |
| --- | --- |
| 接口地址 | `http://127.0.0.1:8787/v1/chat/completions` |
| API Key | `node src/cli.mjs key` 输出的本机密钥 |
| 模型名称 | `node src/cli.mjs models` 输出的一个 slug |
| 自定义协议 | 开启，使 WorkBuddy 按完整地址请求 |
| 工具调用 | 开启 |
| 图片输入 | 仅在所选模型支持、且你需要图片时开启 |
| 思考强度 | 默认不强制设置；如设置，必须是该模型支持的档位 |

若你的版本使用 Base URL 而非完整接口地址，填 `http://127.0.0.1:8787/v1`，
并让客户端自动添加 `/chat/completions`；不要同时手填完整路径又重复追加。

保存后，在 WorkBuddy 对话的模型选择器中明确选中这个自定义模型。
不要使用 Auto 模式来判断是否走了桥接。

先测试一句普通问答，再在专用测试文件夹内要求“列出文件并读取一个测试文本”。
后者用于确认客户端实际的多轮工具调用能往返，问答通过不足以说明 Agent 兼容。
同时核对 ChatGPT 用量页里的该应用记录。

## 5. 支持范围与实现要点

| 功能 | 原型行为 |
| --- | --- |
| OAuth | Authorization Code + PKCE S256，验证 state、nonce、JWKS 签名和身份 |
| 令牌 | 到期前刷新，进程间文件锁串行化，旋转后原子保存 |
| 文本与图片 | 文本；用户提供的 HTTPS/内联 image_url，是否接受取决于模型 |
| 系统提示词 | 原位置转换成 developer 消息，不移动到末尾、不降为用户消息 |
| 工具 | Chat function tools 放入 workbuddy namespace，保留调用 ID 和参数 |
| 工具执行 | 仍由 WorkBuddy 执行，桥接只转换调用与结果 |
| 流式返回 | Responses SSE → Chat Completions SSE，处理拆包、UTF-8、并行调用 |
| 非流式返回 | 上游仍流式读取，等 response.completed 后聚合成 JSON |
| 历史 | 每次转换 WorkBuddy 传来的完整历史，不使用 previous_response_id |
| 取消与失败 | 断开时取消上游；不自动重试推理，错误不冒充成功结束 |
| 本机鉴权 | 独立随机 bearer 密钥，限制 Host，拒绝浏览器 Origin |

每次上游推理固定 `store:false`、`stream:true`。
`temperature`、`top_p`、输出长度预算及其他合同中列出的不支持字段会被移除，
移除字段名通过 `x-bridge-ignored-parameters` 返回；**这些限制没有被模拟实现**。
因此 WorkBuddy 的“最大输出”设置在此路由不会生效。

以下功能明确不支持：命名的强制 tool_choice、n>1、结构化输出约束、音频/视频、
Files 上传、托管检索/代码解释器/图像生成/电脑操作、任意厂商扩展字段。
遇到这些请求会报错，或按合同移除明确列出的字段，不会静默改用 API Key 计费。
本原型不缓存和重放 Responses 的加密 reasoning 状态，也不保留 assistant phase；
长程推理和部分 Codex 模型可能需要进一步适配，不能视为官方 Codex 客户端的等价实现。

## 6. 错误排查

| 错误 | 处理 |
| --- | --- |
| `login_required` | 运行 `login` |
| `plan_usage_not_granted` | 在浏览器重新授权套餐使用 |
| `subscription_sharing_user_not_eligible` | 所选账号、工作区或政策不满足条件；不能用重试绕过 |
| `subscription_sharing_usage_limit_exceeded` | 暂停请求，检查 ChatGPT 用量页与应用限额 |
| `unsupported_request` | 根据返回的 param 找出 WorkBuddy 发送的不兼容字段 |
| `invalid_local_key` | WorkBuddy 应填本机 key，不是 OpenAI token；确认两个终端使用同一个 data-dir |
| `truncated_stream` / `upstream_timeout` | 请求未完成，检查网络；服务没有返回成功标记 |
| `credential_store_busy` | 检查是否有另一个登录/刷新进程；确认没有进程使用后才处理残留的 `.auth.lock` |
| `EADDRINUSE` | 服务加 `--port 8788`，同时修改 WorkBuddy 接口地址 |

HTTP 上游错误保留状态码、错误 code、`Retry-After` 和请求 ID，不转发可能包含敏感内容
的原始 HTML/错误文本。流式开始后无法修改 HTTP 状态码，所以用 SSE error 事件返回错误，
并省略成功 finish chunk 与 `[DONE]`。个别客户端如何显示流中错误，仍需真实验收。

## 7. 停止授权和切换账号

```bash
node src/cli.mjs logout
```

先撤销可续期会话，成功后清除本地令牌，保留客户端注册和本机密钥。
撤销失败时保留令牌，以便重试；也可以在 ChatGPT 设置中断开应用。

默认数据位于本目录 `.local/`，目录权限 0700，凭据文件权限 0600。
不要分享该目录。源码打包时须排除它。
本原型每个 data-dir 对应一个账号注册。使用其他账号时，为所有命令提供相同的新目录：

```bash
node src/cli.mjs login --data-dir ./second-account-private
node src/cli.mjs serve --data-dir ./second-account-private --port 8788
```

自定义目录也包含令牌，不要提交或打包它。停止旧账号服务后再切换。

## 8. 验证

```bash
npm test
```

测试运行真实本地 HTTP 服务和上游模拟服务，包含 RSA 签名 OAuth、回调、刷新、
文本/流式/并行工具与第二轮结果、限额、超时和断流。所有凭据均为合成 fixture。
`postman/` 提供同一模拟服务的 Postman Simulation 配置与独立的端到端验收脚本。
测试不登录真实账号、不消耗套餐，也不启动或修改 WorkBuddy。

真实验收顺序：`login` → `models` → `verify` → 启动服务 → WorkBuddy 选择模型 →
普通问答 → 只读工具任务 → 核对用量页。任何一项失败，都不能宣称主模型已经成功切换。

## 官方资料

- [官方 OAuth 注册流程](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [套餐授权推理要求](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [会话与令牌刷新](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [当前限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [WorkBuddy 模型配置](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model)

官方套餐接入教程覆盖本地个人项目等适用场景；若扩展为付费或面向其他用户的托管服务，
需要按官方申请流程处理，不能直接沿用个人原型的接入假设。
