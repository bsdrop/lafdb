/**
 * WARP suggestion banner.
 *
 * Fetches https://www.cloudflare.com/cdn-cgi/trace and checks warp=off.
 * If the user is NOT on WARP, shows a dismissible banner suggesting WARP.
 * Dismissed state persists in localStorage ("warp_banner_dismissed").
 * Can be suppressed permanently with: localStorage.setItem('warp_banner_dismissed','1')
 */
(function () {
	const STORAGE_KEY = "warp_banner_dismissed";
	const BANNER_ID = "_warp-banner";

	if (localStorage.getItem(STORAGE_KEY)) return;

	const CSS = `
#_warp-banner {
	position: fixed; bottom: 0; left: 0; right: 0; z-index: 8900;
	background: #18181b; border-top: 1px solid #2a2a2a;
	padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px));
	display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	font-size: 13px; line-height: 1.5; color: #aaa;
	animation: _warp-slide .25s ease;
}
@keyframes _warp-slide {
	from { transform: translateY(100%); opacity: 0; }
	to   { transform: translateY(0);    opacity: 1; }
}
#_warp-banner p { margin: 0; flex: 1; min-width: 200px; }
#_warp-banner a { color: #e5ff00; text-decoration: none; }
#_warp-banner a:hover { text-decoration: underline; }
._warp-btn {
	padding: 6px 14px; border-radius: 8px; font-size: 12px;
	cursor: pointer; border: 1px solid #2a2a2a; background: transparent;
	color: #777; font-family: inherit; white-space: nowrap;
	transition: color .15s, border-color .15s;
}
._warp-btn:hover { color: #ccc; border-color: #444; }
`;

	function inject() {
		if (document.getElementById("_warp-styles")) return;
		const s = document.createElement("style");
		s.id = "_warp-styles";
		s.textContent = CSS;
		document.head.appendChild(s);
	}

	function dismiss() {
		localStorage.setItem(STORAGE_KEY, "1");
		document.getElementById(BANNER_ID)?.remove();
	}

	function showBanner() {
		if (document.getElementById(BANNER_ID)) return;
		inject();
		const banner = document.createElement("div");
		banner.id = BANNER_ID;
		banner.innerHTML =
			`<p>🚀 <strong style="color:#e0e0e0">더 빠른 연결을 원하시나요?</strong>&ensp;` +
			`<a href="https://one.one.one.one/" target="_blank" rel="noopener">Cloudflare WARP</a>` +
			`를 사용하면 캐시·CDN 경로 최적화로 훨씬 쾌적해져요.</p>` +
			`<button class="_warp-btn" id="_warp-dismiss">괜찮아요</button>`;
		document.body.appendChild(banner);
		document.getElementById("_warp-dismiss")!.addEventListener("click", dismiss);
	}

	fetch("https://www.cloudflare.com/cdn-cgi/trace", { cache: "no-store" })
		.then((r) => r.text())
		.then((text) => {
			if (/^warp=off/m.test(text)) {
				if (/^fl=/m.test(text)) showBanner();
			}
		})
		.catch((err) => {
			console.debug("WARP check failed (this is usually fine):", err);
		});
})();

export {};
