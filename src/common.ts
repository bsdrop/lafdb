import "./pwa";
import "./share-link";
import "./telemetry";
import "./compat-notice";
import { initConsoleLogStore } from "./console-log-store";
import { apiFetch } from "./shared/api";

(window as any).apiFetch = apiFetch;
initConsoleLogStore();

if (navigator.onLine) import("./warp-suggest");
document.querySelector("noscript")?.remove();
