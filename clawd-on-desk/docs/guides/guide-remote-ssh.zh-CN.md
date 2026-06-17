# 远程 SSH 操作指南

远程 SSH 的默认入口是 Clawd 应用内的 **Settings -> 远程 SSH**。旧的
`scripts/remote-deploy.sh` 只作为源码 checkout / 调试备选，不再作为 DMG /
安装包用户的主流程。

## 前提条件

- 本地 Clawd 正在运行
- 本机能通过系统 `ssh` 连接远端
- 远端已安装 Node.js
- 远端已安装至少一个支持的 agent：Claude Code、Codex CLI 或 Copilot CLI

Clawd 不保存 SSH 密码或私钥口令。首次 host key 确认、passphrase、ssh-agent
加载都交给系统 `ssh` 和系统终端处理。

## 应用内流程

1. 打开 **Settings -> 远程 SSH**。
2. 点击 **新增配置**，填写：
   - **主机**：`user@remote-host`，也可以填你在 `~/.ssh/config` 里配置好的 Host alias
   - **SSH 端口**：默认 `22`
   - **私钥文件**：可选，留空则使用 ssh-agent 或 `~/.ssh/config`
   - **远端转发端口**：默认 `23333`；同一台远端有多个 profile 时才需要换到 `23334-23337`
   - **主机前缀**：可选，用于 Sessions / Dashboard 里区分远端来源
3. 如果 SSH 需要首次确认 host key、输入 passphrase 或加载 ssh-agent，点 **首次认证**。Clawd 会打开系统终端运行一次普通 `ssh`。
4. 点击 **一键部署**。
   - Clawd 会先打开并维护 `ssh -R` 反向隧道
   - 然后从当前已安装的 Clawd 应用复制 hook 文件到远端 `~/.claude/hooks/`
   - 接着在远端已安装对应 agent 时，以远程模式注册 Claude Code hooks、Codex official hooks 和 Copilot CLI hooks
   - 配置下方会展示连接 / 部署日志
5. 在远端终端里启动 Claude Code、Codex CLI 或 Copilot CLI。Dashboard 会在第一条远端 hook 事件到达后显示 session。

全新本机安装下，如果只是接收远程 Copilot CLI 事件，请到 **Settings -> Agents**
打开 **Copilot CLI**，这样 Clawd 才会接收远程 hook 事件；不需要点
**Install / 安装**，除非你也想在本机安装 Copilot hooks。

如果配置里开启了 **连接时自动启动 Codex 兜底监控**，Clawd 会在连接后通过 SSH
拉起 `~/.claude/hooks/codex-remote-monitor.js`。Codex official hooks 正常可用时不依赖这个兜底监控。

## 关键概念

Doctor 里显示的本地服务 `127.0.0.1:<端口>` 是正常的：它是你这台电脑上的
Clawd HTTP 服务，不是远端集群的 IP。远端 hook 也不直接访问你的局域网 IP。

实际链路是：

```
远端 Claude/Codex/Copilot hook
  -> POST http://127.0.0.1:<远端转发端口>
  -> SSH 反向隧道
  -> 本机 Clawd http://127.0.0.1:<本地运行端口>
  -> Dashboard / Session HUD / 桌宠状态
```

所以“已连接”只说明隧道通了。远端 session 要出现在 Dashboard 里，还必须满足：

- 远端 hooks 已部署成功
- 远端 agent 已启动并产生至少一条 hook 事件
- Codex 如需 `/hooks` review，已经在远端 Codex TUI 里 review 通过
- 全新本机安装下，如果只接收远程 Copilot CLI，本机 **Settings -> Agents -> Copilot CLI** 已打开

## Doctor 与远端的边界

Doctor 的 **Agent 集成**检查只诊断本机配置，例如本机
`~/.claude/settings.json` 里的 hook path。它不会 SSH 到远端检查远端
`~/.claude/settings.json`、`~/.codex/hooks.json` 或
`~/.copilot/hooks/hooks.json`。

因此，本机 Claude Code 显示 `broken path` 只代表本机 Claude hook 路径异常，
不等于远端 SSH 部署失败。远端状态请看 Remote SSH profile 里的 **Hook 状态**
和部署进度日志。

## 源码脚本备选

只有在你从源码目录运行时，才建议使用：

```bash
bash scripts/remote-deploy.sh user@remote-host
```

这个脚本会复制当前源码树里的 `hooks/` 文件并打印手动 SSH 配置建议。DMG /
安装包用户不需要源码目录，应使用 Settings -> 远程 SSH 的 **一键部署**。

## 常见问题

### Dashboard 中没有远端 session

先看 Remote SSH profile：

- 如果 Hook 状态是“从未部署”，点 **一键部署**
- 如果状态是“已连接”但 Dashboard 仍为空，在远端 agent 里发送一条消息触发 hook
- 如果是 Codex，远端 Codex 可能还需要执行 `/hooks` review

### 远端端口冲突

如果连接失败并提示远端端口被占用，把 profile 的 **远端转发端口** 从 `23333`
换到 `23334-23337` 中的另一个端口，然后重新一键部署。

### 远端没有 Node.js

部署会在 `check-node` 步骤失败。先在远端安装 Node.js，再重新部署。

### 仍想手动开 SSH 隧道

可以手动运行等价的反向转发：

```bash
ssh -R 127.0.0.1:23333:127.0.0.1:23333 user@remote-host
```

但这只建立隧道，不会部署 hooks。仍需要先通过 Remote SSH 或源码脚本完成远端 hook 部署。
