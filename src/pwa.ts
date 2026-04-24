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

  (window as unknown as Record<string, unknown>)["__refreshCache"] = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sw = reg.active;
      if (sw) {
        await new Promise<void>((resolve) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = () => resolve();
          sw.postMessage({ type: "refresh-shell" }, [ch.port2]);
          setTimeout(resolve, 20000);
        });
      }
    } catch (e) {
      console.warn("[pwa] refreshCache:", e);
    }
    location.reload();
  };
}
