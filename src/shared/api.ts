import { decode } from "@msgpack/msgpack";

declare global {
  interface Window {
    apiFetch: typeof apiFetch;
  }
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/msgpack, application/json, */*");
  }

  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get("Content-Type");
  if (contentType?.includes("application/msgpack")) {
    const buffer = await res.arrayBuffer();
    return decode(buffer) as T;
  }

  return res.json() as Promise<T>;
}
