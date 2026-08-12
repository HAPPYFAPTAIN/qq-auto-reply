# qq-relay

QQ 自动回复中继：NapCat OneBot v11 收消息 → 本地模型代理 → 以本人 QQ 发送。
附带一个本地 OpenAI 兼容模型代理（可切换 opencode / deepseek / kimi）。

## 架构

```
qq-onebot-relay.js   QQ 自动回复：监听 OneBot WS 消息 → LLM 生成 → 以本人身份发送
model-proxy.js       本地 OpenAI 兼容代理（127.0.0.1:8899/v1），按模型名路由到各家
persona.txt          回复人格：以本人身份说话、不暴露 AI、敏感事不代办
auto-relay.config.example.json   配置样例（复制为 auto-relay.config.json 使用）
start-auto-reply.ps1 一键启动（模型代理 + QQ relay + 微信 relay）
stop-auto-reply.ps1  一键停止
```

## 前置

- NapCat（OneBot v11）已启动并登录你的 QQ
- `ws` npm 包可用（`npm install ws` 或在含 ws 的 node_modules 下运行）

## 配置

复制 `auto-relay.config.example.json` 为 `auto-relay.config.json`：

- `qq.enabled`：总开关
- `qq.token` / `qq.selfId`：NapCat 的 OneBot token 和你的 QQ 号
  （也支持环境变量 `QQ_ONEBOT_TOKEN` / `QQ_SELF_ID`）
- `qq.replyPrivate` / `qq.replyGroups`：私聊/群聊开关
- `qq.groupMode`：`all`（所有群）| `mention`（只回 @ 你的）| `whitelist`
- 延时、概率、安静时段等都在 `qq.*` 里可调

LLM 通过 `llm.baseUrl` 指向本地代理（默认 `http://127.0.0.1:8899/v1`），
模型名带前缀可路由：`opencode/deepseek-v4-flash`、`deepseek/deepseek-chat`、`kimi/k3-256k`。

API key 全部走环境变量：`OPENCODE_API_KEY` / `DEEPSEEK_API_KEY` / `KIMI_API_KEY`。

## 运行

```bash
node qq-onebot-relay.js        # QQ 自动回复
node model-proxy.js            # 本地模型代理
```

或使用 PowerShell 脚本一键启停（会同时管理微信 relay，路径按需修改）。

## 安全提示

- 自动回复会对外发声，回复概率、延时、安静时段请自行调好
- 聊天历史缓存在本地 `data/`，日志在 `logs/`，均已 gitignore
- 本仓库已去除个人敏感信息，部署前请替换占位符/环境变量
