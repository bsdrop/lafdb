declare global {
  interface Window {
    __cfBeacon?: unknown;
    Telemetry: {
      openInfo: () => void;
      optout: () => void;
      getConsent: () => string | null;
    };
  }
}

(function () {
  "use strict";

  const CF_TOKEN = "d0d90fa14df84d7c90c724873e3df1ec";
  const STORAGE_KEY = "telemetry_consent"; // "yes" | "no"

  const CSS = `
	#_tm-banner {
		position: fixed; bottom: 0; left: 0; right: 0; z-index: 9000;
		background: #18181b; border-top: 1px solid #2a2a2a;
		padding: 14px 16px calc(14px + env(safe-area-inset-bottom, 0px));
		display: flex; flex-direction: column; gap: 10px;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		font-size: 13px; line-height: 1.5; color: #ccc;
		animation: _tm-slide .25s ease;
	}
	@keyframes _tm-slide {
		from { transform: translateY(100%); opacity: 0; }
		to	 { transform: translateY(0);	opacity: 1; }
	}
	#_tm-banner p { margin: 0; }
	#_tm-banner-btns { display: flex; gap: 8px; flex-wrap: wrap; }
	._tm-btn {
		padding: 7px 16px; border-radius: 8px; font-size: 13px;
		cursor: pointer; border: 1px solid #2a2a2a;
		background: transparent; color: #777;
		font-family: inherit;
		transition: color .15s, border-color .15s, background .15s;
		white-space: nowrap;
	}
	._tm-btn:hover { color: #e0e0e0; border-color: #444; }
	._tm-btn._tm-accept {
		background: #e5ff00; color: #000;
		border-color: #e5ff00; font-weight: 600;
	}
	._tm-btn._tm-accept:hover { background: #d4ec00; }
	._tm-link {
		background: none; border: none; color: #e5ff00;
		font-size: 13px; cursor: pointer; padding: 0;
		font-family: inherit; text-decoration: underline;
	}
	._tm-link:hover { opacity: .8; }

	#_tm-modal-bg {
		display: none; position: fixed; inset: 0; z-index: 9100;
		background: rgba(0,0,0,.72); backdrop-filter: blur(4px);
		align-items: center; justify-content: center; padding: 20px;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	}
	#_tm-modal-bg._tm-open { display: flex; }
	#_tm-modal {
		background: #18181b; border: 1px solid #2e2e2e;
		border-radius: 14px; padding: 24px;
		max-width: 500px; width: 100%;
		max-height: 82vh; overflow-y: auto;
		color: #e0e0e0; font-size: 14px; line-height: 1.65;
	}
	#_tm-modal h2 { font-size: 16px; margin: 0 0 12px; color: #fff; }
	#_tm-modal h3 {
		font-size: 11px; margin: 16px 0 6px; color: #888;
		text-transform: uppercase; letter-spacing: .06em;
	}
	#_tm-modal ul { padding-left: 18px; color: #bbb; margin: 0; }
	#_tm-modal ul li { margin-bottom: 5px; }
	#_tm-modal p { margin: 0 0 10px; color: #bbb; }
	#_tm-modal ._tm-modal-footer { margin-top: 20px; display: flex; gap: 8px; flex-wrap: wrap; }
	#_tm-modal a { color: #e5ff00; text-decoration: none; }
	#_tm-modal a:hover { text-decoration: underline; }
	#_tm-modal::-webkit-scrollbar { width: 4px; }
	#_tm-modal::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
	._tm-toast {
		position: fixed; bottom: 24px; right: 20px; z-index: 9500;
		background: #27272a; border: 1px solid #3f3f46;
		border-radius: 10px; padding: 12px 16px;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		font-size: 13px; color: #ccc; max-width: 320px;
		box-shadow: 0 4px 16px rgba(0,0,0,.4);
		animation: _tm-slide .2s ease;
	}
	._tm-toast._tm-warn { border-color: #7c3d12; color: #fdba74; }
	._tm-note {
		margin-top: 14px; padding: 10px 12px;
		background: rgba(255,255,255,.04); border-radius: 8px;
		font-size: 12px; color: #666; line-height: 1.5;
	}
	#_tm-modal abbr[title] {
		cursor: help; text-underline-offset: 2px;
	}
	._tm-abbr-tip {
		position: fixed; z-index: 9200;
		background: #27272a; border: 1px solid #3f3f46;
		border-radius: 8px; padding: 7px 11px;
		font-size: 12px; color: #e0e0e0; line-height: 1.4;
		max-width: 220px; pointer-events: none;
		box-shadow: 0 4px 16px rgba(0,0,0,.5);
	}
	`;

  function injectStyles(): void {
    if (document.getElementById("_tm-styles")) return;
    const style = document.createElement("style");
    style.id = "_tm-styles";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function showToast(msg: string, warn?: boolean): void {
    const t = document.createElement("div");
    t.className = "_tm-toast" + (warn ? " _tm-warn" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }

  function loadBeacon(): void {
    if (document.getElementById("_tm-beacon")) return;
    const BEACON_URL = "https://static.cloudflareinsights.com/beacon.min.js";
    const onBlocked = (() => {
      let called = false;
      return () => {
        if (called) return;
        called = true;
        // setConsent("no");
        showToast(
          "성능 데이터 수집이 차단되었습니다. 브라우저 설정 또는 광고 차단기의 상태를 확인해주시기 바랍니다.",
          true,
        );
      };
    })();
    fetch(BEACON_URL, { mode: "no-cors" })
      .then(() => {
        const s = document.createElement("script");
        s.id = "_tm-beacon";
        s.defer = true;
        s.src = BEACON_URL;
        s.dataset.cfBeacon = JSON.stringify({ token: CF_TOKEN });
        s.onerror = onBlocked;
        document.head.appendChild(s);
        setTimeout(() => {
          if (!window.__cfBeacon)
            showToast(
              "성능 데이터 수집이 차단되었습니다. 브라우저 설정 또는 광고 차단기의 상태를 확인해주시기 바랍니다.",
              true,
            );
        }, 5000);
      })
      .catch(onBlocked);
  }

  function createModal(): void {
    if (document.getElementById("_tm-modal-bg")) return;
    const bg = document.createElement("div");
    bg.id = "_tm-modal-bg";
    bg.setAttribute("role", "dialog");
    bg.setAttribute("aria-modal", "true");
    bg.innerHTML = `<div id="_tm-modal">
	<h2>📊 어떤 정보가 수집되나요?</h2>
	<p>
		사이트를 보다 빠르고 안정적으로 만들기 위해, 간단한 이용 통계를 확인하고 있어요.<br>
		이 데이터는 페이지를 새로고침하면 사라지는 일시적인 정보이며,&nbsp;
		사용자 기기에 별도로 저장되지는 않습니다.
	</p>

	<h3>수집되는 정보</h3>
	<ul>
		<li>방문한 페이지와 이전 페이지</li>
		<li>페이지 성능 지표(예: <abbr title="화면의 가장 큰 요소가 표시되기까지 걸린 시간">LCP</abbr>, <abbr title="화면 요소가 갑자기 움직이는 정도">CLS</abbr>, <abbr title="클릭이나 입력에 대한 반응 속도">INP</abbr>)</li>
		<li>이미지, 스크립트 등의 리소스 로딩 시간</li>
		<li>브라우저 메모리 사용량</li>
		<li>브라우저 및 운영체제 종류</li>
		<li>대략적인 국가 또는 지역 정보</li>
	</ul>

	<h3>수집하지 않는 정보</h3>
	<ul>
		<li>이름, 이메일, 로그인 정보 같은 개인정보</li>
		<li>쿠키, localStorage, sessionStorage, IndexedDB의 내용</li>
		<li>브라우저의 지문 정보</li>
		<li>광고 추적</li>
		<li>IP 주소</li>
	</ul><br>
	<small>
		데이터는 성능 개선을 위한 용도로만 사용됩니다.&nbsp;
		개인을 식별하거나 추적하는 용도로는 사용하지 않습니다.
	</small>

	<p style="margin-top:12px; font-size:12px; color:#555;">
		<a href="https://developers.cloudflare.com/speed/observatory/rum-beacon/#data-collection"
			 target="_blank" rel="noopener">자세히 보기 ↗</a>
	</p>

	<div class="_tm-modal-footer">
		<button class="_tm-btn _tm-accept" id="_tm-modal-close">확인</button>
	</div>
</div>`;

    document.body.appendChild(bg);

    let abbrTip: HTMLElement | null = null;
    function dismissTip(): void {
      abbrTip?.remove();
      abbrTip = null;
      bg.querySelectorAll("abbr[data-tm-tip-open]").forEach((el) => el.removeAttribute("data-tm-tip-open"));
    }
    bg.addEventListener("click", (e) => {
      const abbr = (e.target as Element).closest("#_tm-modal abbr[title]") as HTMLElement | null;
      if (abbr) {
        e.stopPropagation();
        const isSame = abbrTip && abbr.dataset["tmTipOpen"] === "1";
        dismissTip();
        if (isSame) return;
        abbr.dataset["tmTipOpen"] = "1";
        const tip = document.createElement("div");
        tip.className = "_tm-abbr-tip";
        tip.textContent = abbr.title;
        document.body.appendChild(tip);
        abbrTip = tip;
        const r = abbr.getBoundingClientRect();
        const tw = tip.offsetWidth,
          th = tip.offsetHeight;
        const left = Math.min(Math.max(r.left, 8), window.innerWidth - tw - 8);
        const top = r.top - th - 6 < 8 ? r.bottom + 6 : r.top - th - 6;
        tip.style.left = left + "px";
        tip.style.top = top + "px";
        return;
      }
      dismissTip();
      if (e.target === bg) closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && bg.classList.contains("_tm-open")) closeModal();
    });
    document.getElementById("_tm-modal-close")!.addEventListener("click", closeModal);
  }

  function openModal(): void {
    createModal();
    document.getElementById("_tm-modal-bg")!.classList.add("_tm-open");
  }
  function closeModal(): void {
    document.getElementById("_tm-modal-bg")?.classList.remove("_tm-open");
    document.querySelectorAll("._tm-abbr-tip").forEach((el) => el.remove());
  }

  function setConsent(val: string): void {
    localStorage.setItem(STORAGE_KEY, val);
  }

  function isAnonymousNetworkHost(): boolean {
    const host = location.hostname.toLowerCase().replace(/\.$/, "");
    return host.endsWith(".i2p") || host.endsWith(".onion");
  }

  function setupOptout(): void {
    document.querySelectorAll("[data-tm-optout]").forEach((btn) => {
      btn.addEventListener("click", doOptout);
    });
  }

  function doOptout(): void {
    if (!confirm("통계 수집을 끄시겠습니까?\n이미 수집된 데이터는 삭제되지 않습니다.")) return;
    setConsent("no");
    location.reload();
  }

  function showBanner(): void {
    if (document.getElementById("_tm-banner")) return;
    const banner = document.createElement("div");
    banner.id = "_tm-banner";
    banner.innerHTML = `
<p>
	성능 데이터 수집을 활성화하시겠습니까?&nbsp;
	<button class="_tm-link" id="_tm-what"><small>무엇이 수집되나요?</small></button>
</p>
<div id="_tm-banner-btns">
	<button class="_tm-btn" id="_tm-yes">허용</button>
	<button class="_tm-btn _tm-accept" id="_tm-no">거절</button>
</div>`;
    document.body.appendChild(banner);

    document.getElementById("_tm-yes")!.addEventListener("click", () => applyConsent("yes"));
    document.getElementById("_tm-no")!.addEventListener("click", () => applyConsent("no"));
    document.getElementById("_tm-what")!.addEventListener("click", openModal);
  }

  function hideBanner(): void {
    document.getElementById("_tm-banner")?.remove();
  }

  function applyConsent(val: string): void {
    setConsent(val);
    hideBanner();
    if (val === "yes") loadBeacon();
  }

  window.Telemetry = {
    openInfo: openModal,
    optout: doOptout,
    getConsent: () => localStorage.getItem(STORAGE_KEY),
  };

  function init(): void {
    injectStyles();

    let stored = localStorage.getItem(STORAGE_KEY);
    const hasStoredConsent = stored === "yes" || stored === "no";

    if (isAnonymousNetworkHost() && !hasStoredConsent) {
      setConsent("no");
      stored = "no";
    }

    if (stored === "yes") {
      loadBeacon();
    } else if (stored !== "no") {
      showBanner();
    }

    if (stored === "yes" || stored === "no") setupOptout();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

export {};
