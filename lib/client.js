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
				notifyOnQuestion: v.notifyOnQuestion !== false,
				volume: typeof v.volume === "number" ? v.volume : DEFAULT_VOLUME
			};
		}
		function currentCfg() {
			if (!scope) return { enabled: true, sound: true, notify: true, notifyOnError: true, notifyOnQuestion: true, volume: DEFAULT_VOLUME };
			return snapshotCfg(scope.getSnapshot());
		}

		// ---------- 提示音（HTML5 audio 元素，后台标签页也能响；WAV 内嵌，无需文件） ----------
		const beepWavCache = {};
		function buildBeepWav(tones) {
			const key = tones.map((t) => t.f + "-" + t.d + "-" + t.s).join("_");
			if (beepWavCache[key]) return beepWavCache[key];
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
				for (const tone of tones) addTone(tone.f, tone.d, tone.s);
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
				const url = "data:audio/wav;base64," + btoa(bin);
				beepWavCache[key] = url;
			} catch (e) {
				console.warn("[notify] 提示音生成失败", e);
			}
			return beepWavCache[key];
		}
		// 完成音（叮咚）；提问音（上行三音，示意"需要你回应"）
		const COMPLETE_TONES = [{ f: 880, d: 0.18, s: 0 }, { f: 660, d: 0.32, s: 0.26 }];
		const QUESTION_TONES = [{ f: 659, d: 0.15, s: 0 }, { f: 880, d: 0.15, s: 0.18 }, { f: 1046, d: 0.28, s: 0.36 }];
		function playSound(vol, tones) {
			try {
				if (typeof Audio === "undefined") return;
				const url = buildBeepWav(tones || COMPLETE_TONES);
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
		function showNotification(title, body, sessionId) {
			if (!("Notification" in window)) return;
			const fire = () => {
				try {
					const notification = new Notification(title || "DSH 回答完成", { body, silent: true });
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
			if (c.notify) showNotification("DSH 回答完成", body, sessionId);
			console.log("[notify]", new Date().toLocaleTimeString(), body, "(实例 #" + INST_ID + ")");
		}

		// ---------- DSH 会话事件流（/api/events.mux） ----------
		function onFrame(raw) {
			let msg;
			try { msg = JSON.parse(raw); } catch { return; }
			if (!msg || msg.type !== "server-request") return;
			const p = msg.payload;
			if (!p || typeof p !== "object") return;
			if (p.type === "session/event") {
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
			} else if (p.type === "question/requested") {
				onQuestionRequested(p.sessionId, p.questions);
			}
		}

		// ---------- agent 提问时提醒（ask_user_question） ----------
		function onQuestionRequested(sessionId, questions) {
			const c = currentCfg();
			if (!c.enabled || !c.notifyOnQuestion) return;
			if (!Array.isArray(questions) || questions.length === 0) return;
			const ids = questions.map((q) => (q && q.id) || "?").join(",");
			if (!dedupeNotify(sessionId, "q:" + ids)) return; // 提问去重（同一批问题只弹一次）
			const text = questions.map((q) => {
				let s = "";
				if (q && q.header) s += q.header + "：";
				s += (q && q.question) || "";
				if (q && Array.isArray(q.options) && q.options.length) {
					s += "（" + q.options.map((o, i) => (i + 1) + "." + (o && o.label)).join("  ") + "）";
				}
				return s;
			}).join(" ｜ ");
			const body = "会话 " + shortId(sessionId) + "\n" + (text.slice(0, 140) || "需要你回答");
			if (c.sound) playSound(c.volume, QUESTION_TONES);
			if (c.notify) showNotification("DSH 需要你回答", body, sessionId);
			console.log("[notify] 提问", new Date().toLocaleTimeString(), body, "(实例 #" + INST_ID + ")");
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

		// ---------- 设置卡片 UI 样式（注入到文档，使用 DSH CSS 变量保持视觉一致） ----------
		const CARD_CSS = [
			".dsh-n_card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
			".dsh-n_card:hover{border-color:var(--dsw-alias-label-dimmed)}",
			".dsh-n_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
			".dsh-n_header{appearance:none;width:100%;font:inherit;display:flex;align-items:center;gap:8px;padding:12px 14px;cursor:pointer;background:0 0;border:0;color:inherit;text-align:left}",
			".dsh-n_headText{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}",
			".dsh-n_name{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:1.4}",
			".dsh-n_desc{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.5}",
			".dsh-n_chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .15s}",
			".dsh-n_chevronOpen{transform:rotate(180deg)}",
			".dsh-n_body{display:flex;flex-direction:column;padding:0 14px 12px}",
			".dsh-n_row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}",
			".dsh-n_row:last-child{border-bottom:none}",
			".dsh-n_label{flex:1;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}",
			".dsh-n_switch{position:relative;width:36px;height:20px;flex-shrink:0}",
			".dsh-n_switch input{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}",
			".dsh-n_switchTrack{display:block;width:100%;height:100%;border-radius:10px;background:var(--dsw-alias-fill-l2);transition:background .2s}",
			".dsh-n_switch input:checked+.dsh-n_switchTrack{background:var(--dsw-alias-label-primary)}",
			".dsh-n_switchKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.25)}",
			".dsh-n_switch input:checked~.dsh-n_switchKnob{transform:translateX(16px)}",
			".dsh-n_switch input:focus-visible+.dsh-n_switchTrack{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".dsh-n_switch input:disabled+.dsh-n_switchTrack{opacity:.4;cursor:not-allowed}",
			".dsh-n_sliderRow{display:flex;align-items:center;gap:10px;padding:10px 0}",
			".dsh-n_slider{flex:1;height:6px;-webkit-appearance:none;appearance:none;border-radius:3px;background:var(--dsw-alias-border-l2);outline:none}",
			".dsh-n_slider::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary);cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.2)}",
			".dsh-n_slider::-moz-range-thumb{width:16px;height:16px;border:none;border-radius:50%;background:var(--dsw-alias-label-primary);cursor:pointer}",
			".dsh-n_slider:disabled{opacity:.4}",
			".dsh-n_sliderVal{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary);width:40px;text-align:right}"
		];
		function injectCardStyles() {
			const tagId = "@dsh-local/notify/plugin-card";
			if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]")) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "@dsh-local/notify";
				tag.dataset.pluginCss = tagId;
				tag.textContent = CARD_CSS.join("\n");
				document.head.appendChild(tag);
			}
		}

		function ChevronSVG(props) {
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16",
				width: "14",
				height: "14",
				className: "dsh-n_chevron" + (props.open ? " dsh-n_chevronOpen" : ""),
				children: react_jsx_runtime.jsx("path", { d: "M4.5 6l3.5 3.5 3.5-3.5", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" })
			});
		}

		function Switch({ checked, disabled, onChange }) {
			return react_jsx_runtime.jsxs("label", { className: "dsh-n_switch", children: [
				react_jsx_runtime.jsx("input", { type: "checkbox", checked: !!checked, disabled, onChange: (e) => onChange(e.target.checked) }),
				react_jsx_runtime.jsx("span", { className: "dsh-n_switchTrack" }),
				react_jsx_runtime.jsx("span", { className: "dsh-n_switchKnob" })
			] });
		}

		function NotifyCard(props) {
			const snapshot = props.useNotify();
			const [open, setOpen] = react.useState(false);
			if (!scope || !snapshot || !snapshot.value) return null;
			const cv = snapshotCfg(snapshot);
			const writable = snapshot.writable !== false;
			const onToggle = (field, value) => scope.set(field, value);
			return react_jsx_runtime.jsxs("li", { style: { listStyle: "none" }, children: [
				react_jsx_runtime.jsxs("div", { className: "dsh-n_card", children: [
					react_jsx_runtime.jsxs("button", {
						type: "button",
						className: "dsh-n_header",
						"aria-expanded": open,
						"aria-label": (open ? "收起设置" : "展开设置") + "：通知",
						onClick: () => setOpen(!open),
						children: [
							react_jsx_runtime.jsxs("div", { className: "dsh-n_headText", children: [
								react_jsx_runtime.jsx("span", { className: "dsh-n_name", children: "通知" }),
								react_jsx_runtime.jsx("span", { className: "dsh-n_desc", children: "提示音 + 系统通知提醒（可单独开关）" })
							] }),
							react_jsx_runtime.jsx(ChevronSVG, { open })
						]
					}),
					open && react_jsx_runtime.jsxs("div", { className: "dsh-n_body", children: [
						!writable && react_jsx_runtime.jsx("p", { style: { margin: "0 0 8px", fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }, children: "设置为只读" }),
						react_jsx_runtime.jsxs("label", { className: "dsh-n_row", children: [
							react_jsx_runtime.jsx("span", { className: "dsh-n_label", children: "启用提醒" }),
							react_jsx_runtime.jsx(Switch, { checked: !!cv.enabled, disabled: !writable, onChange: (v) => onToggle("enabled", v) })
						] }),
						react_jsx_runtime.jsxs("label", { className: "dsh-n_row", children: [
							react_jsx_runtime.jsx("span", { className: "dsh-n_label", children: "提示音" }),
							react_jsx_runtime.jsx(Switch, { checked: !!cv.sound, disabled: !writable || !cv.enabled, onChange: (v) => onToggle("sound", v) })
						] }),
						react_jsx_runtime.jsxs("label", { className: "dsh-n_row", children: [
							react_jsx_runtime.jsx("span", { className: "dsh-n_label", children: "系统通知" }),
							react_jsx_runtime.jsx(Switch, { checked: !!cv.notify, disabled: !writable || !cv.enabled, onChange: (v) => onToggle("notify", v) })
						] }),
						react_jsx_runtime.jsxs("label", { className: "dsh-n_row", children: [
							react_jsx_runtime.jsx("span", { className: "dsh-n_label", children: "出错 / 中止也提醒" }),
							react_jsx_runtime.jsx(Switch, { checked: !!cv.notifyOnError, disabled: !writable || !cv.enabled, onChange: (v) => onToggle("notifyOnError", v) })
						] }),
						react_jsx_runtime.jsxs("label", { className: "dsh-n_row", children: [
							react_jsx_runtime.jsx("span", { className: "dsh-n_label", children: "提问时也提醒" }),
							react_jsx_runtime.jsx(Switch, { checked: !!cv.notifyOnQuestion, disabled: !writable || !cv.enabled, onChange: (v) => onToggle("notifyOnQuestion", v) })
						] }),
						react_jsx_runtime.jsxs("label", { className: "dsh-n_row", children: [
							react_jsx_runtime.jsx("span", { className: "dsh-n_label", children: "音量" }),
							react_jsx_runtime.jsx("input", { type: "range", min: 0, max: 1, step: 0.05, value: cv.volume, disabled: !writable || !cv.enabled, className: "dsh-n_slider", onChange: (e) => onToggle("volume", Number(e.target.value)) }),
							react_jsx_runtime.jsx("span", { className: "dsh-n_sliderVal", children: Math.round(cv.volume * 100) + "%" })
						] })
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
			injectCardStyles();
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
