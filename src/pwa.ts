if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[pwa] service worker register failed:", err);
    });
  });

  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "sw-log") return;
    if (data.extra === undefined) {
      console.log(`[sw] ${data.message}`);
      return;
    }
    console.log(`[sw] ${data.message}`, data.extra);
  });
}
