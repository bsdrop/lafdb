import { applyImportData, clearAllWatchHistory, getExportData, isExportKey } from "../watch-history";
import { MANUAL_COMMENTS_KEY, MANUAL_THUMBS_KEY, OFFLINE_DB_NAME, OFFLINE_MODE_KEY } from "./constants";
import {
	describeOfflineScope,
	formatOfflineTime,
	getOfflineMeta,
	getOfflineScope,
	getOfflineStatus,
	isManualCommentsEnabled,
	isManualThumbsEnabled,
	isOfflineItemModeReady,
	isOfflineModeEnabled,
	maybePromptResumeOfflineSync,
	normalizeOfflineScope,
	refreshOfflineMeta,
	saveOfflineScope,
	subscribeOfflineStatus,
	syncOfflineMetadata,
} from "./offline-sync";
import type { OfflineScope } from "./types";

type InitSettingsOptions = {
	onRefreshFeed: () => void;
};

const html = (s: TemplateStringsArray, ...args: any[]) => s.map((p, i) => p + (args[i] || "")).join("");

export function initSettings({ onRefreshFeed }: InitSettingsOptions) {
	const panel = document.getElementById("settings-panel")!;
	const overlay = document.getElementById("settings-overlay")!;
	const settingsBtn = document.getElementById("btn-settings") as HTMLButtonElement;
	const closeSettingsBtn = document.getElementById("btn-close-settings") as HTMLButtonElement;
	let previouslyFocused: HTMLElement | null = null;
	let settingsPushed = false;
	let mdPushed = false;
	let pendingBacks = 0; // programmatic history.back() calls in flight
	const backgroundRoots = [
		document.getElementById("header"),
		document.getElementById("feed-status"),
		document.getElementById("grid"),
		document.getElementById("sentinel"),
	].filter((el): el is HTMLElement => !!el);

	function getPanelFocusable(): HTMLElement[] {
		return Array.from(
			panel.querySelectorAll<HTMLElement>(
				'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
			),
		).filter((el) => !el.hidden && el.offsetParent !== null);
	}

	function setBackgroundAccessibility(hidden: boolean) {
		for (const root of backgroundRoots) {
			root.toggleAttribute("inert", hidden);
			if (hidden) root.setAttribute("aria-hidden", "true");
			else root.removeAttribute("aria-hidden");
		}
	}

	function openSettings() {
		previouslyFocused = document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
		panel.classList.add("open");
		overlay.classList.add("open");
		panel.setAttribute("aria-hidden", "false");
		settingsBtn.setAttribute("aria-expanded", "true");
		setBackgroundAccessibility(true);
		syncSettingsUI();
		requestAnimationFrame(() => {
			closeSettingsBtn.focus({ preventScroll: true });
		});
		history.pushState({ lafModal: "settings" }, "");
		settingsPushed = true;
	}

	function closeSettings() {
		const wasOpen = panel.classList.contains("open");
		panel.classList.remove("open");
		overlay.classList.remove("open");
		panel.setAttribute("aria-hidden", "true");
		settingsBtn.setAttribute("aria-expanded", "false");
		setBackgroundAccessibility(false);
		qualAdvPanel.style.display = "none";
		const playerAdvPanel = document.getElementById("player-adv-panel") as HTMLElement | null;
		if (playerAdvPanel) playerAdvPanel.style.display = "none";
		qualAdvBtn?.setAttribute("aria-expanded", "false");
		playerAdvBtn?.setAttribute("aria-expanded", "false");
		if (!wasOpen) return;
		const restoreTarget = previouslyFocused ?? settingsBtn;
		previouslyFocused = null;
		requestAnimationFrame(() => {
			if (document.contains(restoreTarget)) {
				restoreTarget.focus({ preventScroll: true });
			}
		});
		if (settingsPushed) {
			settingsPushed = false;
			pendingBacks++;
			history.back();
		}
	}

	settingsBtn.addEventListener("click", openSettings);
	closeSettingsBtn.addEventListener("click", closeSettings);
	overlay.addEventListener("click", closeSettings);
	window.addEventListener("popstate", () => {
		if (pendingBacks > 0) {
			pendingBacks--;
			return;
		}
		// log viewer manages its own popstate; skip if it's open
		if (document.getElementById("laf-log-viewer")) return;
		if (mdModal.classList.contains("open")) {
			mdPushed = false;
			closeMdModal();
		} else if (panel.classList.contains("open")) {
			settingsPushed = false;
			closeSettings();
		}
	});

	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			closeSettings();
			closeMdModal();
			return;
		}
		if (e.key === "Tab" && panel.classList.contains("open")) {
			const focusable = getPanelFocusable();
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const active = document.activeElement;

			if (!panel.contains(active)) {
				e.preventDefault();
				first.focus();
				return;
			}
			if (e.shiftKey && active === first) {
				e.preventDefault();
				last.focus();
				return;
			}
			if (!e.shiftKey && active === last) {
				e.preventDefault();
				first.focus();
			}
		}
	});

	// --- Markdown Modal ---
	const mdModal = document.getElementById("md-modal")!;
	const mdOverlay = document.getElementById("md-modal-overlay")!;
	const mdContent = document.getElementById("md-modal-content")!;

	function openMdModal(title: string, url: string) {
		document.getElementById("md-modal-title")!.textContent = title;
		mdContent.innerHTML = "로딩 중...";
		mdModal.classList.add("open");
		mdOverlay.classList.add("open");
		history.pushState({ lafModal: "md" }, "");
		mdPushed = true;

		fetch(url)
			.then(r => r.text())
			.then(text => {
				mdContent.innerHTML = simpleMarkdown(text);
			})
			.catch(err => {
				mdContent.textContent = "불러오기에 실패하였습니다. " + err.message;
			});
	}

	function closeMdModal() {
		const wasOpen = mdModal.classList.contains("open");
		mdModal.classList.remove("open");
		mdOverlay.classList.remove("open");
		if (wasOpen && mdPushed) {
			mdPushed = false;
			pendingBacks++;
			history.back();
		}
	}

	document.getElementById("btn-show-notices")?.addEventListener("click", () => {
		openMdModal("오픈소스 라이선스", "/THIRD-PARTY-NOTICES.md");
	});
	document.getElementById("btn-open-console-logs")?.addEventListener("click", () => {
		window.__lafLogViewer?.open();
	});
	document.getElementById("btn-close-md-modal")?.addEventListener("click", closeMdModal);
	mdOverlay.addEventListener("click", closeMdModal);

	function simpleMarkdown(md: string): string {
		const codes: string[] = [];
		const escapeHtml = (value: string) =>
			value
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
		// Protect code blocks
		let res = md.replace(/```([\s\S]*?)```/g, (_, code) => {
			const id = `__CODE_${codes.length}__`;
			codes.push(`<pre style="font-family:monospace;white-space:pre-wrap;word-break:break-word;background:#000;padding:12px;border-radius:8px;border:1px solid #222;overflow-x:auto;margin:1em 0;font-size:12px;color:#ccc;line-height:1.4">${escapeHtml(code.trim())}</pre>`);
			return `\n\n${id}\n\n`;
		});

		res = res
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			// HR
			.replace(/^---$/gm, "<hr>")
			// Headers
			.replace(/^# (.*$)/gm, "<h1>$1</h1>")
			.replace(/^## (.*$)/gm, "<h2>$1</h2>")
			.replace(/^### (.*$)/gm, "<h3>$1</h3>")
			// Inline code
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			// Bold
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			// Links
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
			// Autolinks like <https://example.com>
			.replace(/&lt;(https?:\/\/[^<>\s]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
			// Lists
			.replace(/^\s*[\*\-] (.*$)/gm, "<li>$1</li>");

		// Group <li> into <ul>
		res = res.replace(/(<li>.*<\/li>(\n<li>.*<\/li>)*)/g, "<ul>$1</ul>");

		// Paragraphs and Block handling
		let html = res.split(/\n\n+/).map(p => {
			const trimmed = p.trim();
			if (!trimmed) return "";
			if (trimmed.startsWith("<")) return trimmed;
			// Don't wrap placeholders
			if (trimmed.startsWith("__CODE_") && trimmed.endsWith("__")) return trimmed;
			return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
		}).join("\n");

		// Restore code blocks
		codes.forEach((code, i) => {
			html = html.replace(`__CODE_${i}__`, code);
		});

		return html;
	}

	const tmToggle = document.getElementById("toggle-telemetry") as HTMLInputElement | null;
	const cvToggle = document.getElementById("toggle-cv") as HTMLInputElement | null;
	const offlineModeToggle = document.getElementById("toggle-offline-mode") as HTMLInputElement | null;
	const btnSyncItems = document.getElementById("btn-sync-items") as HTMLButtonElement | null;
	const btnSyncEpisodes = document.getElementById("btn-sync-episodes") as HTMLButtonElement | null;
	const manualThumbsToggle = document.getElementById("toggle-manual-thumbs") as HTMLInputElement | null;
	const manualCommentsToggle = document.getElementById("toggle-manual-comments") as HTMLInputElement | null;
	const itemsSubtext = document.getElementById("offline-items-subtext") as HTMLElement | null;
	const episodesSubtext = document.getElementById("offline-episodes-subtext") as HTMLElement | null;
	const originalItemsDesc = "검색 및 자동완성용 작품 목록을 기기에 저장";
	const originalEpisodesDesc = "제목, 번호, 시간 등의 상세 정보를 함께 저장";

	function applyCvAuto() {
		const pref = localStorage.getItem("cv_auto");
		if (pref === null) {
			localStorage.setItem("cv_auto", "yes");
		}
		document.body.classList.toggle("cv-auto", localStorage.getItem("cv_auto") !== "no");
	}
	applyCvAuto();

	const apToggle = document.getElementById("toggle-autoplay") as HTMLInputElement | null;
	const asToggle = document.getElementById("toggle-autoskip") as HTMLInputElement | null;
	const tpToggle = document.getElementById("toggle-timepref") as HTMLInputElement | null;
	const shareLaftelToggle = document.getElementById("toggle-share-laftel") as HTMLInputElement | null;
	const qualSel = document.getElementById("sel-quality-pref") as HTMLElement;
	const qualRadios = () => qualSel.querySelectorAll<HTMLInputElement>("input[type=radio]");
	const getQualVal = () => qualSel.querySelector<HTMLInputElement>("input:checked")?.value ?? "";
	const setQualVal = (v: string) => {
		const r = qualSel.querySelector<HTMLInputElement>(`input[value="${CSS.escape(v)}"]`);
		if (r) r.checked = true;
		else qualRadios().forEach((x) => {
			x.checked = false;
		});
	};

	const qualAdvBtn = document.getElementById("btn-quality-adv") as HTMLButtonElement;
	const qualAdvPanel = document.getElementById("quality-adv-panel") as HTMLElement;
	const qualBpsInput = document.getElementById("qual-bps-input") as HTMLInputElement;
	const qualPrefSub = document.getElementById("quality-pref-sub") as HTMLElement;
	const playerAdvBtn = document.getElementById("btn-player-adv") as HTMLButtonElement | null;
	const playerAdvPanel = document.getElementById("player-adv-panel") as HTMLElement | null;
	const bufferAheadInput = document.getElementById("input-buffer-ahead") as HTMLInputElement | null;
	const bufferBehindInput = document.getElementById("input-buffer-behind") as HTMLInputElement | null;
	const bufferPruneDelayInput = document.getElementById("input-buffer-prune-delay") as HTMLInputElement | null;
	const DEFAULT_BUFFER_AHEAD = 40;
	const DEFAULT_BUFFER_BEHIND = 30;
	const DEFAULT_BUFFER_PRUNE_DELAY = 0;
	const MIN_BUFFER_SECONDS = 18;
	const MAX_BUFFER_SECONDS = 300;
	const MAX_BUFFER_PRUNE_DELAY = 60;

	function getBpsPref(): number {
		return parseInt(localStorage.getItem("quality_pref_bps") || "0", 10);
	}

	function clampBufferSeconds(value: number, fallback: number): number {
		if (!Number.isFinite(value)) return fallback;
		return Math.max(MIN_BUFFER_SECONDS, Math.min(MAX_BUFFER_SECONDS, Math.round(value)));
	}

	function getBufferPref(key: string, fallback: number): number {
		return clampBufferSeconds(parseInt(localStorage.getItem(key) || String(fallback), 10), fallback);
	}

	function clampBufferPruneDelay(value: number): number {
		if (!Number.isFinite(value)) return DEFAULT_BUFFER_PRUNE_DELAY;
		return Math.max(0, Math.min(MAX_BUFFER_PRUNE_DELAY, Math.round(value)));
	}

	function getBufferPruneDelayPref(): number {
		return clampBufferPruneDelay(parseInt(localStorage.getItem("player_buffer_prune_delay") || String(DEFAULT_BUFFER_PRUNE_DELAY), 10));
	}

	function setBufferPref(key: string, value: number, fallback: number) {
		if (value === fallback) localStorage.removeItem(key);
		else localStorage.setItem(key, String(value));
	}

	function updateBufferUI(ahead: number, behind: number, pruneDelay: number) {
		if (bufferAheadInput) bufferAheadInput.value = String(ahead);
		if (bufferBehindInput) bufferBehindInput.value = String(behind);
		if (bufferPruneDelayInput) bufferPruneDelayInput.value = String(pruneDelay);
		playerAdvBtn?.classList.toggle(
			"active",
			ahead !== DEFAULT_BUFFER_AHEAD ||
				behind !== DEFAULT_BUFFER_BEHIND ||
				pruneDelay !== DEFAULT_BUFFER_PRUNE_DELAY,
		);
	}

	function applyBufferPrefs(ahead: number, behind: number, pruneDelay: number) {
		const nextAhead = clampBufferSeconds(ahead, DEFAULT_BUFFER_AHEAD);
		const nextBehind = clampBufferSeconds(behind, DEFAULT_BUFFER_BEHIND);
		const nextPruneDelay = clampBufferPruneDelay(pruneDelay);
		setBufferPref("player_buffer_ahead", nextAhead, DEFAULT_BUFFER_AHEAD);
		setBufferPref("player_buffer_behind", nextBehind, DEFAULT_BUFFER_BEHIND);
		if (nextPruneDelay === DEFAULT_BUFFER_PRUNE_DELAY) localStorage.removeItem("player_buffer_prune_delay");
		else localStorage.setItem("player_buffer_prune_delay", String(nextPruneDelay));
		updateBufferUI(nextAhead, nextBehind, nextPruneDelay);
	}

	function updateBpsUI(bps: number) {
		qualBpsInput.value = bps > 0 ? String(bps) : "";
		qualBpsInput.classList.toggle("active", bps > 0);
		qualAdvBtn.classList.toggle("active", bps > 0);
		document.querySelectorAll<HTMLButtonElement>(".qual-preset").forEach((btn) => {
			btn.classList.toggle("active", Number(btn.dataset.bps) === bps);
		});
		qualPrefSub.textContent = bps > 0 ? `비트레이트 목표: ${bps} kbps` : "스트리밍 시작 시 선호 화질";
	}

	function applyBps(bps: number) {
		if (bps > 0) {
			localStorage.setItem("quality_pref_bps", String(bps));
			localStorage.removeItem("quality_pref");
			setQualVal("");
		} else {
			localStorage.removeItem("quality_pref_bps");
		}
		updateBpsUI(bps);
	}

	function syncSettingsUI() {
		if (tmToggle) tmToggle.checked = localStorage.getItem("telemetry_consent") === "yes";
		if (cvToggle) cvToggle.checked = localStorage.getItem("cv_auto") !== "no";
		if (offlineModeToggle) offlineModeToggle.checked = localStorage.getItem(OFFLINE_MODE_KEY) === "yes";
		if (manualThumbsToggle) manualThumbsToggle.checked = isManualThumbsEnabled();
		if (manualCommentsToggle) manualCommentsToggle.checked = isManualCommentsEnabled();
		if (apToggle) apToggle.checked = localStorage.getItem("player_autoplay") !== "off";
		if (asToggle) asToggle.checked = localStorage.getItem("player_autoskip") !== "off";
		if (tpToggle) tpToggle.checked = (localStorage.getItem("time_pref") || "relative") === "relative";
		if (shareLaftelToggle) shareLaftelToggle.checked = localStorage.getItem("share_laftel_url") === "yes";
		setQualVal(localStorage.getItem("quality_pref") || "");
		updateBpsUI(getBpsPref());
		updateBufferUI(
			getBufferPref("player_buffer_ahead", DEFAULT_BUFFER_AHEAD),
			getBufferPref("player_buffer_behind", DEFAULT_BUFFER_BEHIND),
			getBufferPruneDelayPref(),
		);
	}

	function renderOfflineSettings() {
		const status = getOfflineStatus();
		const meta = getOfflineMeta();
		const isSyncing = status.phase === "syncing";
		const syncStage = meta.syncState.stage;

		// --- Works Row ---
		if (btnSyncItems) {
			btnSyncItems.disabled = isSyncing;
			btnSyncItems.textContent = meta.itemCount > 0 ? "업데이트" : "다운로드";
		}
		if (itemsSubtext) {
			if (isSyncing && syncStage === "items") {
				const progress = `(${status.downloaded.toLocaleString()} / ${status.total.toLocaleString()})`;
				itemsSubtext.textContent = `작품 목록 가져오는 중... ${progress}`;
				itemsSubtext.style.color = "var(--brand)";
				itemsSubtext.style.fontWeight = "500";
			} else if (meta.itemCount > 0) {
				itemsSubtext.textContent = `${meta.itemCount.toLocaleString()}개 저장됨 (최근: ${formatOfflineTime(meta.updatedAt)})`;
				itemsSubtext.style.color = "";
				itemsSubtext.style.fontWeight = "";
			} else {
				itemsSubtext.textContent = originalItemsDesc;
				itemsSubtext.style.color = "";
				itemsSubtext.style.fontWeight = "";
			}
		}

		// --- Episodes Row ---
		if (btnSyncEpisodes) {
			btnSyncEpisodes.disabled = isSyncing;
			btnSyncEpisodes.textContent = meta.episodeCount > 0 ? "업데이트" : "다운로드";
		}
		if (episodesSubtext) {
			if (isSyncing && syncStage === "episodes") {
				const progress = `(작품: ${status.downloaded.toLocaleString()} / ${status.total.toLocaleString()})`;
				episodesSubtext.textContent = `에피소드 ${meta.episodeCount.toLocaleString()}개 완료 ${progress}`;
				episodesSubtext.style.color = "var(--brand)";
				episodesSubtext.style.fontWeight = "500";
			} else if (meta.episodeCount > 0) {
				episodesSubtext.textContent = `${meta.episodeCount.toLocaleString()}개 저장됨 (최근: ${formatOfflineTime(meta.updatedAt)})`;
				episodesSubtext.style.color = "";
				episodesSubtext.style.fontWeight = "";
			} else {
				episodesSubtext.textContent = originalEpisodesDesc;
				episodesSubtext.style.color = "";
				episodesSubtext.style.fontWeight = "";
			}
		}

		if (offlineModeToggle) {
			offlineModeToggle.disabled = isSyncing;
		}
	}

	subscribeOfflineStatus(renderOfflineSettings);
	renderOfflineSettings();

	cvToggle?.addEventListener("change", () => {
		localStorage.setItem("cv_auto", cvToggle.checked ? "yes" : "no");
		applyCvAuto();
	});

	manualThumbsToggle?.addEventListener("change", () => {
		localStorage.setItem(MANUAL_THUMBS_KEY, manualThumbsToggle.checked ? "yes" : "no");
	});

	manualCommentsToggle?.addEventListener("change", () => {
		localStorage.setItem(MANUAL_COMMENTS_KEY, manualCommentsToggle.checked ? "yes" : "no");
	});

	offlineModeToggle?.addEventListener("change", () => {
		if (getOfflineStatus().phase === "syncing") {
			syncSettingsUI();
			return;
		}
		if (!offlineModeToggle.checked) {
			localStorage.setItem(OFFLINE_MODE_KEY, "no");
			renderOfflineSettings();
			onRefreshFeed();
			return;
		}

		localStorage.setItem(OFFLINE_MODE_KEY, "yes");
		renderOfflineSettings();
		onRefreshFeed();
	});

	function startSync(scope: OfflineScope) {
		if (getOfflineStatus().phase === "syncing") return;
		saveOfflineScope(scope);
		if (!confirm(`오프라인 메타데이터를 다운로드하시겠습니까?\n범위: ${describeOfflineScope(scope)}`)) return;
		syncOfflineMetadata()
			.then(() => {
				if (isOfflineItemModeReady() || isOfflineModeEnabled()) onRefreshFeed();
			})
			.catch((e) => console.error("Manual sync failed:", e));
	}

	btnSyncItems?.addEventListener("click", () => startSync({ items: true, episodes: false }));
	btnSyncEpisodes?.addEventListener("click", () => {
		const m = getOfflineMeta();
		if (m.itemCount === 0) {
			if (confirm("에피소드 데이터를 받으려면 먼저 작품 데이터가 필요합니다. 작품과 에피소드를 모두 다운로드하시겠습니까?")) {
				startSync({ items: true, episodes: true });
			}
		} else {
			startSync({ items: false, episodes: true });
		}
	});

	apToggle?.addEventListener("change", () => {
		localStorage.setItem("player_autoplay", apToggle.checked ? "on" : "off");
	});
	asToggle?.addEventListener("change", () => {
		localStorage.setItem("player_autoskip", asToggle.checked ? "on" : "off");
	});
	tpToggle?.addEventListener("change", () => {
		localStorage.setItem("time_pref", tpToggle.checked ? "relative" : "absolute");
	});
	shareLaftelToggle?.addEventListener("change", () => {
		if (shareLaftelToggle.checked) localStorage.setItem("share_laftel_url", "yes");
		else localStorage.removeItem("share_laftel_url");
	});
	qualRadios().forEach((r) =>
		r.addEventListener("change", () => {
			const v = getQualVal();
			localStorage.removeItem("quality_pref_bps");
			updateBpsUI(0);
			if (v) localStorage.setItem("quality_pref", v);
			else localStorage.removeItem("quality_pref");
		}),
	);

	qualAdvBtn.addEventListener("click", () => {
		const open = qualAdvPanel.style.display !== "none" && qualAdvPanel.style.display !== "";
		qualAdvPanel.style.display = open ? "none" : "block";
		qualAdvBtn.setAttribute("aria-expanded", String(!open));
		if (!open) qualBpsInput.focus();
	});

	playerAdvBtn?.addEventListener("click", () => {
		if (!playerAdvPanel) return;
		const open = playerAdvPanel.style.display !== "none" && playerAdvPanel.style.display !== "";
		playerAdvPanel.style.display = open ? "none" : "block";
		playerAdvBtn.setAttribute("aria-expanded", String(!open));
		if (!open) bufferAheadInput?.focus();
	});

	qualBpsInput.addEventListener("change", () => {
		const v = parseInt(qualBpsInput.value || "0", 10);
		applyBps(v > 0 ? v : 0);
	});
	qualBpsInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") (e.target as HTMLInputElement).blur();
	});

	document.querySelectorAll<HTMLButtonElement>(".qual-preset").forEach((btn) => {
		btn.addEventListener("click", () => {
			const bps = Number(btn.dataset.bps);
			applyBps(bps === getBpsPref() ? 0 : bps);
		});
	});

	function commitBufferPrefsFromInputs() {
		applyBufferPrefs(
			parseInt(bufferAheadInput?.value || String(DEFAULT_BUFFER_AHEAD), 10),
			parseInt(bufferBehindInput?.value || String(DEFAULT_BUFFER_BEHIND), 10),
			parseInt(bufferPruneDelayInput?.value || String(DEFAULT_BUFFER_PRUNE_DELAY), 10),
		);
	}

	bufferAheadInput?.addEventListener("change", commitBufferPrefsFromInputs);
	bufferBehindInput?.addEventListener("change", commitBufferPrefsFromInputs);
	bufferPruneDelayInput?.addEventListener("change", commitBufferPrefsFromInputs);
	bufferAheadInput?.addEventListener("keydown", (e) => {
		if (e.key === "Enter") (e.target as HTMLInputElement).blur();
	});
	bufferBehindInput?.addEventListener("keydown", (e) => {
		if (e.key === "Enter") (e.target as HTMLInputElement).blur();
	});
	bufferPruneDelayInput?.addEventListener("keydown", (e) => {
		if (e.key === "Enter") (e.target as HTMLInputElement).blur();
	});

	tmToggle?.addEventListener("change", () => {
		localStorage.setItem("telemetry_consent", tmToggle.checked ? "yes" : "no");
		location.reload();
	});

	document.getElementById("btn-tm-info")!.addEventListener("click", () => {
		closeSettings();
		window.Telemetry?.openInfo();
	});

	void refreshOfflineMeta()
		.then(() => {
			renderOfflineSettings();
			maybePromptResumeOfflineSync();
		})
		.catch((e) => console.error("Initial meta refresh failed:", e));

	document.getElementById("btn-export")!.addEventListener("click", () => {
		const payload = {
			version: 1,
			exportedAt: new Date().toISOString(),
			data: getExportData(),
		};
		const blob = new Blob([JSON.stringify(payload, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `latfel-backup-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	});

	document.getElementById("btn-import")!.addEventListener("click", () => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json,application/json";
		input.addEventListener("change", async () => {
			const file = input.files?.[0];
			if (!file) return;

			let payload: any;
			try {
				payload = JSON.parse(await file.text());
			} catch {
				alert("파일을 읽을 수 없습니다. 올바른 JSON 파일인지 확인해주세요.");
				return;
			}

			if (payload.version !== 1 || typeof payload.data !== "object" || payload.data === null) {
				alert("지원하지 않는 백업 파일 형식입니다.");
				return;
			}

			const entries = Object.entries(payload.data).filter(([key]) => isExportKey(key));
			if (entries.length === 0) {
				alert("가져올 데이터가 없습니다.");
				return;
			}

			const overwrite = entries.filter(([key]) => localStorage.getItem(key) !== null);
			const mode = chooseImportMode(entries.length, overwrite.length);
			if (!mode) return;
			const { imported, failed } = applyImportData(Object.fromEntries(entries), mode);

			alert(
				failed > 0
					? `${imported}개 가져오기 완료, ${failed}개 실패.\n페이지를 새로고침합니다.`
					: `${imported}개 항목을 성공적으로 가져왔습니다.\n페이지를 새로고침합니다.`,
			);
			location.reload();
		});
		input.click();
	});

	function chooseImportMode(totalCount: number, overwriteCount: number) {
		return 'merge'; // TODO: FIXME
		const answer = prompt(
			overwriteCount > 0
				? `백업 파일에서 ${totalCount}개 항목을 가져옵니다.\nmerge 또는 overwrite를 입력해주세요.\nmerge: 없는 항목만 추가하고, 시청 기록은 더 많이 본 쪽을 유지합니다.\noverwrite: 백업 파일 기준으로 덮어씁니다.`
				: `백업 파일에서 ${totalCount}개 항목을 가져옵니다.\nmerge 또는 overwrite를 입력해주세요.`,
			"merge",
		);
		if (answer === null) return "";
		const normalized = String(answer).trim().toLowerCase();
		if (normalized === "merge" || normalized === "m") return "merge";
		if (normalized === "overwrite" || normalized === "o") return "overwrite";
		alert("가져오기를 취소했습니다. merge 또는 overwrite만 입력하실 수 있습니다.");
		return "";
	}

	async function deleteOfflineDatabase() {
		await new Promise<void>((resolve) => {
			const req = indexedDB.deleteDatabase(OFFLINE_DB_NAME);
			req.onsuccess = () => resolve();
			req.onerror = () => resolve();
			req.onblocked = () => resolve();
		});
	}

	document.getElementById("btn-clear-watch")!.addEventListener("click", () => {
		if (!confirm("모든 시청 위치 기록을 삭제할까요?")) return;
		clearAllWatchHistory();
		alert("시청 위치 기록을 삭제했습니다.");
		closeSettings();
	});

	document.getElementById("btn-clear-all")?.addEventListener("click", async () => {
		if (!confirm("모든 저장 데이터(시청 기록, 설정, 로컬 DB, 캐시, 서비스 워커)를 삭제할까요?\n이 작업은 되돌릴 수 없습니다.\n\n삭제 후에도 업데이트가 안 된다면 Ctrl+Shift+R, 모바일에서는 다른 브라우저 앱으로 재접속해 주세요.")) return;

		await deleteOfflineDatabase();
		localStorage.clear();
		sessionStorage.clear();

		if ((window as any).__refreshCache) {
			await (window as any).__refreshCache({ silent: true });
		} else {
			location.reload();
		}
	});
}
