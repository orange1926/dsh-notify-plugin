# DSH 回答完成提醒插件（@dsh-local/notify）

DeepSeek Harness（dsh）的**回答完成提醒**插件：一次回答（`turn/end`）结束时——

- 🔔 **提示音**（HTML5 audio，后台标签页也能响）
- 🔔 **Windows 系统通知**（浏览器通知中心）
- 🖱️ **点击通知**：聚焦现有 DSH 标签页 + 切换到对应会话（不开新窗口）
- ⚙️ 设置卡片里**自由开关**：总开关 / 提示音 / 系统通知 / 出错也提醒 / 音量

> DSH 目前（0.1.0-rc.6）**不自带** notify 插件；本插件是纯增量，不占据任何内置插件位置。

## 安装

需要 dsh web 已安装（`npx @deepseek-ai/dsh web`）。

```bash
# 方式一：官方命令（需要 pnpm 在 PATH）
dsh plugin --profile web add github:<你的用户名>/<仓库名>

# 方式二：等价手动流程（corepack pnpm）
cd "$HOME/.dsh/profiles/web"
corepack pnpm add github:<你的用户名>/<仓库名>
```

安装后**重启 dsh web**，刷新浏览器页面。

### ⚠️ 必须：应用 apiproxy 白名单补丁

DSH 对浏览器可读写的设置命名空间有**硬编码白名单**（`dsh-host-apiproxy` 的
`WEB_SETTINGS_NAMESPACES`，官方承认"插件自行暴露配置"为 deferred work）。
不打这个补丁，设置卡片会因读不到数据而不显示。安装后执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\apply-apiproxy-patch.ps1
```

然后重启 dsh web。**DSH 升级后需重跑此脚本。**

## 使用

重启后：**设置 → 插件 → 插件配置 → 回答完成提醒**，自由开关各项。

## 卸载

```bash
dsh plugin --profile web remove @dsh-local/notify
```

并手动从 `profiles/web/package.json` 的 `dsh.profile.bundles` 移除 `@dsh-local/notify`。

## 工作原理

- 标准**组合包（bundle）**格式：`dsh.bundle`（配置层）+ `dsh.client`（浏览器半身）。
- 宿主半身注册 `notify` 设置命名空间（写入 `~/.dsh/settings.yaml`，热更新）。
- 浏览器半身连接 DSH 会话事件流（`/api/events.mux`），监听 `turn/end` 精确事件；
  提示音用 HTML5 audio（后台标签页可播），通知点击后用 `sessions.open()` 切换会话；
  localStorage 做跨标签页去重（多页面时只弹一条）。
- 副作用全部注册在 `ctx.effect()`，插件卸载时自动清理。

## 本地开发

改 `lib/` 下代码后重启 dsh web 即生效（link 依赖指向源码）。

## 许可

MIT
