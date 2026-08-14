import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

/**
 * 回答完成提醒 — 宿主半身。
 * 职责：把 `notify` 设置命名空间注册进用户设置文档（$DSH_HOME/settings.yaml，
 * 热更新），浏览器半身经 settingsScope 读写它。宿主侧无其他行为。
 */
const NOTIFY_SETTINGS_NAMESPACE = "notify";

/** 可持久化的设置 schema；同时是浏览器 scope 的线缆校验信封。 */
const NotifySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  sound: z.boolean().default(true),
  notify: z.boolean().default(true),
  notifyOnError: z.boolean().default(true),
  volume: z.number().min(0).max(1).default(0.35)
});

/** 宿主插件入口：settings 服务就绪后注册命名空间（注册随本 fiber 生命周期自动清理）。 */
function apply(ctx) {
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.register(settingsNamespace(NOTIFY_SETTINGS_NAMESPACE), NotifySettingsSchema);
  });
}

export { NOTIFY_SETTINGS_NAMESPACE, apply };
