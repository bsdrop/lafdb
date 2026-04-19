declare const ManagedMediaSource:
  | (typeof MediaSource & { canConstructInDedicatedWorker?: boolean })
  | undefined;

(function () {
  const ua = navigator.userAgent || "";
  const isAndroid = ua.includes('Android');
  const host = location.hostname.toLowerCase().replace(/\.+$/g, "");
  const isI2P = host.endsWith(".i2p");
  if (!isAndroid && !isI2P) return;
  if (sessionStorage.getItem("compat_notice_dismissed") === "1") return;

  const lacks: string[] = [];
  const lacksWebCrypto = !globalThis.crypto?.subtle;
  const lacksMediaSource =
    typeof MediaSource === "undefined" &&
    typeof ManagedMediaSource === "undefined";

  if (!("serviceWorker" in navigator)) lacks.push("서비스 워커");
  if (lacksWebCrypto) lacks.push("WebCrypto");
  if (lacksMediaSource) lacks.push("MediaSource");
  if (lacks.length === 0) return;
  if (!isAndroid && !(isI2P && (lacksWebCrypto || lacksMediaSource))) return;

  const message = isI2P && (lacksWebCrypto || lacksMediaSource)
    ? `이 브라우저는 ${lacks.join(", ")} 지원이 부족합니다. i2pd 내장 브라우저류 대신 Cromite, Brave 같은 일반 브라우저에 I2P 프록시를 설정해 접속해주시기 바랍니다.`
    : `이 Android 브라우저는 ${lacks.join(", ")} 지원이 부족해 재생이나 오프라인 기능이 제대로 동작하지 않을 수 있습니다.
	이 기기에서 설치 가능한 마지막 IronFox 버전을 사용해 영상을 다운로드하신 뒤, VLC 또는 MPV로 감상하실 것을 권장드립니다.`;

  const banner = document.createElement("div");
  banner.id = "_compat_notice";
  banner.style.cssText = [
    "position:fixed",
    "left:12px",
    "right:12px",
    "bottom:12px",
    "z-index:9400",
    "display:flex",
    "flex-direction:column",
    "gap:10px",
    "padding:14px 16px",
    "border:1px solid #92400e",
    "border-radius:12px",
    "background:#18181b",
    "color:#fdba74",
    'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    "box-shadow:0 10px 30px rgba(0,0,0,.35)",
  ].join(";");
  banner.innerHTML = `
<p style="margin:0;">
	${message}
</p>
<div style="display:flex;gap:8px;flex-wrap:wrap;">
	<button id="_compat_notice_close" style="padding:7px 14px;border-radius:8px;border:1px solid #3f3f46;background:transparent;color:#e5e7eb;font:13px inherit;cursor:pointer;">닫기</button>
</div>
  `;
  document.body.appendChild(banner);
  (document.getElementById("_compat_notice_close") as HTMLButtonElement | null)
    ?.addEventListener("click", () => {
      sessionStorage.setItem("compat_notice_dismissed", "1");
      banner.remove();
    }, { once: true });
})();
