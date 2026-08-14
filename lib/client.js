window.__ModuleLoader__.load({
	id: "@dsh-local/notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		const NS = "notify";
		const DEFAULT_VOLUME = 0.35;
		// 诊断：每页一个实例 ID，用于区分通知来自哪个页面实例
		const INST_ID = Math.random().toString(36).slice(2, 7);
		let instCount = 0;
		try { instCount = Number(sessionStorage.getItem("dsh-notify.instances") || "0") + 1; sessionStorage.setItem("dsh-notify.instances", String(instCount)); } catch (e) {}
		console.log("[notify] 实例 #" + INST_ID + " 启动（本页累计 " + instCount + " 次）");

		// ---------- 设置 ----------
		let scope = null; // SettingsScopeController（ctx.settingsScope.bind）
		function snapshotCfg(snapshot) {
			const v = (snapshot && snapshot.value) || {};
			return {
				enabled: v.enabled !== false,
				sound: v.sound !== false,
				notify: v.notify !== false,
				notifyOnError: v.notifyOnError !== false,
				volume: typeof v.volume === "number" ? v.volume : DEFAULT_VOLUME
			};
		}
		function currentCfg() {
			if (!scope) return { enabled: true, sound: true, notify: true, notifyOnError: true, volume: DEFAULT_VOLUME };
			return snapshotCfg(scope.getSnapshot());
		}

		// ---------- 提示音（HTML5 audio 元素，后台标签页也能响；WAV 内嵌，无需文件） ----------
		let beepWavUrl = null;
		function buildBeepWav() {
			if (beepWavUrl) return beepWavUrl;
			try {
				const sampleRate = 44100;
				const total = Math.ceil(0.62 * sampleRate);
				const samples = new Float32Array(total);
				const addTone = (freq, dur, startAt) => {
					const n = Math.floor(dur * sampleRate);
					for (let i = 0; i < n; i++) {
						const t = i / sampleRate;
						const env = Math.min(1, t / 0.012, (dur - t) / 0.05);
						const idx = Math.floor(startAt * sampleRate) + i;
						if (idx < total) samples[idx] += Math.sin(2 * Math.PI * freq * t) * env;
					}
				};
				addTone(880, 0.18, 0);
				addTone(660, 0.32, 0.26);
				const buffer = new ArrayBuffer(44 + total * 2);
				const view = new DataView(buffer);
				const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
				writeStr(0, "RIFF");
				view.setUint32(4, 36 + total * 2, true);
				writeStr(8, "WAVE");
				writeStr(12, "fmt ");
				view.setUint32(16, 16, true);
				view.setUint16(20, 1, true);
				view.setUint16(22, 1, true);
				view.setUint32(24, sampleRate, true);
				view.setUint32(28, sampleRate * 2, true);
				view.setUint16(32, 2, true);
				view.setUint16(34, 16, true);
				writeStr(36, "data");
				view.setUint32(40, total * 2, true);
				for (let i = 0; i < total; i++) {
					const v = Math.max(-1, Math.min(1, samples[i]));
					view.setInt16(44 + i * 2, Math.round(v * 32767), true);
				}
				const bytes = new Uint8Array(buffer);
				let bin = "";
				for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
				beepWavUrl = "data:audio/wav;base64," + btoa(bin);
			} catch (e) {
				console.warn("[notify] 提示音生成失败", e);
			}
			return beepWavUrl;
		}
		function playSound(vol) {
			try {
				if (typeof Audio === "undefined") return;
				const url = buildBeepWav();
				if (!url) return;
				const audio = new Audio(url);
				audio.volume = Math.max(0, Math.min(1, vol));
				audio.play().catch(() => {});
			} catch (e) {
				console.warn("[notify] 提示音播放失败", e);
			}
		}

		// ---------- Windows 系统通知（浏览器通知中心） ----------
		let permissionRequested = false;
		function ensurePermission() {
			if (!("Notification" in window)) return;
			if (Notification.permission === "default" && !permissionRequested) {
				permissionRequested = true;
				Notification.requestPermission().catch(() => {});
			}
		}
		function showNotification(body, sessionId) {
			if (!("Notification" in window)) return;
			const fire = () => {
				try {
					const notification = new Notification("DSH 回答完成", { body, silent: true });
					notification.onclick = () => {
						// 聚焦现有标签页（不是新开窗口）
						try { window.focus(); } catch (e) {}
						notification.close();
						// 同一页面内切到对应会话
						try {
							const sessions = ctxRef && ctxRef.get("sessions");
							if (sessions && typeof sessions.open === "function" && sessionId) sessions.open(sessionId);
						} catch (e) {
							console.warn("[notify] 切换会话失败", e);
						}
					};
				} catch (e) { console.warn("[notify] 通知失败", e); }
			};
			if (Notification.permission === "granted") fire();
			else if (Notification.permission === "default") ensurePermission();
		}

		// ---------- 会话轮次追踪 ----------
		const startedAt = new Map();
		const lastAnswer = new Map();
		function shortId(id) { return id.length > 12 ? id.slice(0, 8) + "…" : id; }
		function reasonLabel(k) {
			if (k === "completed") return "完成";
			if (k === "error") return "出错";
			if (k === "aborted") return "已中止";
			return k || "结束";
		}
		function textOf(message) {
			if (!message || !Array.isArray(message.content)) return "";
			return message.content
				.filter((b) => b && b.type === "text" && typeof b.text === "string")
				.map((b) => b.text).join("").replace(/\s+/g, " ").trim();
		}
		function fmtDuration(ms) {
			const s = Math.max(0, Math.round(ms / 1000));
			return s >= 60 ? Math.floor(s / 60) + "分" + (s % 60) + "秒" : s + "秒";
		}

		// ---------- 跨标签页去重（localStorage 共享；多个 DSH 页面时只弹一条） ----------
		function dedupeNotify(sessionId, turn) {
			try {
				const key = "dsh-notify.last";
				const now = Date.now();
				const last = JSON.parse(localStorage.getItem(key) || "null");
				if (last && last.sessionId === sessionId && last.turn === turn && now - last.at < 60000) return false;
				localStorage.setItem(key, JSON.stringify({ sessionId, turn, at: now }));
				return true;
			} catch (e) {
				return true;
			}
		}

		function onTurnEnd(sessionId, ev) {
			const c = currentCfg();
			if (!c.enabled) return;
			const reason = ev.data && ev.data.reason ? ev.data.reason.kind : "";
			if (reason !== "completed" && !c.notifyOnError) return;
			const turn = ev.data && ev.data.turn;
			if (!dedupeNotify(sessionId, turn)) return; // 去重（只调用一次）
			const st = startedAt.get(sessionId);
			const dur = st && st.turn === turn ? fmtDuration(Date.now() - st.at) : "";
			const snippet = (lastAnswer.get(sessionId) || "").slice(0, 90);
			let body = "会话 " + shortId(sessionId) + " · 第 " + (turn ?? "?") + " 轮 · " + reasonLabel(reason);
			if (dur) body += " · " + dur;
			if (snippet) body += "\n\n" + snippet;
			if (c.sound) playSound(c.volume);
			if (c.notify) showNotification(body, sessionId);
			console.log("[notify]", new Date().toLocaleTimeString(), body, "(实例 #" + INST_ID + ")");
		}

		// ---------- DSH 会话事件流（/api/events.mux） ----------
		function onFrame(raw) {
			let msg;
			try { msg = JSON.parse(raw); } catch { return; }
			if (!msg || msg.type !== "server-request") return;
			const p = msg.payload;
			if (!p || typeof p !== "object" || msg.method !== "session/event" || p.type !== "session/event") return;
			const ev = p.event;
			if (!ev || typeof ev !== "object") return;
			const sid = p.sessionId;
			if (ev.type === "turn/start") {
				startedAt.set(sid, { turn: ev.data && ev.data.turn, at: Date.now() });
				lastAnswer.delete(sid);
			} else if (ev.type === "assistant/message") {
				const t = textOf(ev.data && ev.data.message);
				if (t) lastAnswer.set(sid, t);
			} else if (ev.type === "turn/end") {
				onTurnEnd(sid, ev);
			}
		}

		let ws = null;
		let retry = 0;
		let reconnectTimer = null;
		function wsUrl() {
			return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/events.mux";
		}
		function connect() {
			try { ws = new WebSocket(wsUrl()); } catch (e) { scheduleReconnect(); return; }
			ws.onopen = () => { retry = 0; console.log("[notify] 事件流已连接"); };
			ws.onmessage = (e) => { try { onFrame(e.data); } catch (err) { console.warn("[notify] 帧处理失败", err); } };
			ws.onclose = () => scheduleReconnect();
			ws.onerror = () => { try { ws.close(); } catch {} };
		}
		function scheduleReconnect() {
			if (reconnectTimer) return;
			const delay = Math.min(10000, 1000 * Math.pow(2, retry++));
			reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
		}
		function stopStream() {
			if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
			if (ws) {
				ws.onclose = null;
				ws.onerror = null;
				try { ws.close(); } catch (e) {}
				ws = null;
			}
		}

		// ---------- 设置卡片（设置 → 插件 → 插件配置） ----------
		const rowStyle = { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18))" };
		const labelStyle = { flex: 1, fontSize: 13, color: "var(--dsw-alias-label-primary, inherit)" };

		function Toggle(props) {
			return react_jsx_runtime.jsxs("label", { style: rowStyle, children: [
				react_jsx_runtime.jsx("span", { style: labelStyle, children: props.label }),
				react_jsx_runtime.jsx("input", {
					type: "checkbox",
					checked: !!props.checked,
					disabled: props.disabled,
					onChange: (e) => props.onChange(e.target.checked)
				})
			] });
		}

		function NotifyCard(props) {
			const snapshot = props.useNotify();
			if (!scope || !snapshot || !snapshot.value) return null;
			const c = snapshotCfg(snapshot);
			const writable = snapshot.writable !== false;
			const cardStyle = {
				boxSizing: "border-box",
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))",
				background: "var(--dsw-alias-bg-layer-2, transparent)",
				borderRadius: 12,
				padding: "10px 14px",
				marginBottom: 10
			};
			return react_jsx_runtime.jsxs("li", { style: { listStyle: "none" }, children: [
				react_jsx_runtime.jsxs("div", { style: cardStyle, children: [
					react_jsx_runtime.jsx("div", { style: { fontWeight: 600, fontSize: 13, color: "var(--dsw-alias-label-primary, inherit)" }, children: "回答完成提醒" }),
					react_jsx_runtime.jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)", margin: "2px 0 6px" }, children: "DSH 回答结束时：提示音 + 系统通知（监听会话事件流 turn/end）" }),
					react_jsx_runtime.jsx(Toggle, { label: "启用提醒", checked: c.enabled, disabled: !writable, onChange: (v) => scope.set("enabled", v) }),
					react_jsx_runtime.jsx(Toggle, { label: "提示音", checked: c.sound, disabled: !writable || !c.enabled, onChange: (v) => scope.set("sound", v) }),
					react_jsx_runtime.jsx(Toggle, { label: "系统通知", checked: c.notify, disabled: !writable || !c.enabled, onChange: (v) => scope.set("notify", v) }),
					react_jsx_runtime.jsx(Toggle, { label: "出错 / 中止也提醒", checked: c.notifyOnError, disabled: !writable || !c.enabled, onChange: (v) => scope.set("notifyOnError", v) }),
					react_jsx_runtime.jsxs("label", { style: { ...rowStyle, borderBottom: "none" }, children: [
						react_jsx_runtime.jsx("span", { style: labelStyle, children: "音量" }),
						react_jsx_runtime.jsx("input", {
							type: "range",
							min: 0,
							max: 1,
							step: 0.05,
							value: c.volume,
							disabled: !writable || !c.enabled,
							onChange: (e) => scope.set("volume", Number(e.target.value))
						}),
						react_jsx_runtime.jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)", width: 40, textAlign: "right" }, children: Math.round(c.volume * 100) + "%" })
					] })
				] })
			] });
		}

		// ---------- 插件入口 ----------
		let ctxRef = null;
		const inject = [
			"slots",
			"settingsScope",
			"connection",
			"remote",
			"sessions"
		];
		function apply(ctx) {
			ctxRef = ctx;
			try {
				scope = ctx.settingsScope.bind({ namespace: NS });
			} catch (e) {
				console.warn("[notify] settingsScope 不可用", e);
				return; // 无设置能力时仍保留提醒（默认配置）
			}
			try {
				ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
					name: "settings.plugin.item",
					id: "notify",
					order: 30,
					label: "回答完成提醒",
					inject: () => ({ useNotify: () => react.useSyncExternalStore(
						(listener) => scope.subscribe(listener),
						() => scope.getSnapshot()
					) })
				}, NotifyCard));
			} catch (e) {
				console.warn("[notify] 设置卡片注册失败", e);
			}
			// 规范：副作用注册进 ctx.effect，插件卸载时自动清理（连接/监听/定时器）
			ctx.effect(() => {
				const onGesture = () => ensurePermission();
				window.addEventListener("pointerdown", onGesture, true);
				connect();
				return () => {
					window.removeEventListener("pointerdown", onGesture, true);
					stopStream();
				};
			}, "notify: runtime");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
