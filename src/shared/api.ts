import { decode } from "@msgpack/msgpack";

declare global {
  interface Window {
    apiFetch: typeof apiFetch;
  }
}

function emitAPIServerError(url: string, status: number, statusText: string): void {
  const pathname = new URL(url, globalThis.location?.href).pathname;
  const event = new CustomEvent("api:server-error", {
    detail: {
      url,
      pathname,
      status,
      statusText,
      message: `API HTTP ${status}: ${pathname}`,
    },
  });

  try {
    globalThis.dispatchEvent(event);
  } catch {
    console.error("Failed to dispatch API server error event", event);
  }
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/msgpack, application/json, */*");
  }

  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    if (res.status >= 500) emitAPIServerError(url, res.status, res.statusText);
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get("Content-Type");
  if (contentType?.includes("application/msgpack")) {
    const buffer = await res.arrayBuffer();
    return decode(buffer) as T;
  }

  return res.json() as Promise<T>;
}
