const MINUTE = 60000, HOUR = 60 * MINUTE;
const CACHE_NAME = "cs2";
const META_CACHE_NAME = "ms2";
const APP_SHELL_TTL_MS = HOUR;
const APP_SHELL = [
	"/", "/manifest.webmanifest", "/accessible.js", "/sw.js", "/THIRD-PARTY-NOTICES.md",
	"/index.html", "/index.css", "/index.js", "/common.js", "/history.html", "/history.css", "/history.js",
	"/item.html", "/item.css", "/item.js", "/player.html", "/player.css", "/player-page.js", "/player.js",
];

async function broadcastToWindows(payload) {
	const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	for (const client of clients) { client.postMessage(payload); }
}

function logSw(message, extra) {
	if (extra === undefined) { console.log(`[sw] ${message}`); }
	else { console.log(`[sw] ${message}`, extra); }
	return broadcastToWindows({ type: "sw-log", message, extra });
}

function buildMetaRequest(request) {
	const url = typeof request === "string" ? request : request.url;
	return new Request(`${url}__sw_meta__`);
}

async function sanitizeResponseForCache(request, response) {
	const url = typeof request === "string" ? new URL(request, self.location.origin) : new URL(request.url);
	const contentType = response.headers.get("content-type") || "";
	
	const isHtml =
		url.pathname.endsWith(".html") ||
		url.pathname === "/" ||
		(contentType.includes("text/html") && !url.pathname.includes("."));

	if (!isHtml) return response;

	const html = await response.text();
	const sanitizedHtml = html
		.replace(/<script[^>]*\/cdn-cgi\/scripts\/[^>]*><\/script>/gi, "")
		.replace(/<script[^>]*data-cfasync[^>]*><\/script>/gi, "")
		.replace(/\s+type="[^"]*-text\/javascript"/gi, "")
		.replace(/\s+data-cfasync="false"/gi, "");

	const headers = new Headers(response.headers);
	headers.delete("speculation-rules");
	headers.delete("Speculation-Rules");
	headers.set("content-type", "text/html; charset=utf-8");

	return new Response(sanitizedHtml, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function writeCacheWithMeta(request, response) {
	if (!response.ok) return response;
	const cache = await caches.open(CACHE_NAME);
	const metaCache = await caches.open(META_CACHE_NAME);
	const cacheableResponse = await sanitizeResponseForCache(request, response.clone());
	await cache.put(request, cacheableResponse);
	await metaCache.put(
		buildMetaRequest(request),
		new Response(JSON.stringify({ cachedAt: Date.now() }), {
			headers: { "content-type": "application/json" }
		}),
	);
	return response;
}

async function getCachedAge(request) {
	if (!request) return Infinity;
	const metaCache = await caches.open(META_CACHE_NAME);
	const meta = await metaCache.match(buildMetaRequest(request));
	if (!meta) return Infinity;
	try {
		const data = await meta.json();
		return Date.now() - Number(data.cachedAt || 0);
	} catch {
		return Infinity;
	}
}

async function refreshAppShell() {
	await logSw("refresh-shell:start", { paths: APP_SHELL });
	const startedAt = Date.now();
	const results = await Promise.all(
		APP_SHELL.map(async (path) => {
			const url = new URL(path, self.location.origin);
			url.searchParams.set("__sw_refresh__", String(startedAt));
			const req = new Request(url, { cache: "no-store" });
			try {
				await logSw("refresh-shell:fetch", { path, url: url.toString() });
				const response = await fetch(req);
				await logSw("refresh-shell:response", { path, status: response.status, ok: response.ok });
				if (response.ok) {
					await writeCacheWithMeta(path, response);
					await logSw("refresh-shell:cached", { path });
					return { path, ok: true, status: response.status };
				}
				return { path, ok: false, status: response.status };
			} catch (err) {
				await logSw("refresh-shell:error", {
					path,
					error: err instanceof Error ? err.message : String(err),
				});
				return {
					path,
					ok: false, status: 0,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}),
	);
	await logSw("refresh-shell:done", {
		ms: Date.now() - startedAt,
		ok: results.filter((result) => result.ok).length,
		total: results.length,
	});
	return results;
}


async function handleStaleWhileRevalidate(request) {
	const cache = await caches.open(CACHE_NAME);
	const url = new URL(request.url);

	// SPA Fallback: / 또는 /index.html 요청 시 캐시에서 검색
	const getCached = async () => {
		let match = await cache.match(request, { ignoreSearch: true });
		if (!match && request.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html")) {
			match = await cache.match("/index.html", { ignoreSearch: true });
		}
		return match;
	};

	const cached = await getCached();
	
	const fetchPromise = fetch(request).then(async (response) => {
		if (response.ok) {
			await writeCacheWithMeta(request, response.clone());
		}
		return response;
	}).catch(() => {
		return cached || Response.error();
	});

	return cached || fetchPromise;
}

async function handleCacheFirst(request, ttl) {
	const cache = await caches.open(CACHE_NAME);
	const cached = await cache.match(request, { ignoreSearch: true });
	const age = await getCachedAge(cached ? request : null);
	
	if (cached && age < ttl) {
		return cached;
	}

	try {
		const response = await fetch(request);
		return await writeCacheWithMeta(request, response);
	} catch (err) {
		return cached || Response.error();
	}
}

async function handleNetworkFirst(request) {
	const cache = await caches.open(CACHE_NAME);
	const url = new URL(request.url);
	
	// SPA Fallback: if not found in cache, try index.html
	const getCached = async () => {
		let match = await cache.match(request, { ignoreSearch: true });
		if (!match && request.mode === "navigate") {
			match = await cache.match("/index.html", { ignoreSearch: true });
		}
		return match;
	};

	try {
		const response = await fetch(request);
		if (response.ok) {
			return await writeCacheWithMeta(request, response);
		}
		const cached = await getCached();
		return cached || response;
	} catch (err) {
		const cached = await getCached();
		return cached || Response.error();
	}
}


self.addEventListener("install", (event) => {
	event.waitUntil(
		Promise.all(
			APP_SHELL.map(async (path) => {
				try {
					const response = await fetch(path, { cache: "no-store" });
					await writeCacheWithMeta(path, response);
				} catch (err) { console.error("SW install fetch failed:", err); }
			}),
		),
	);
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches.keys().then((keys) =>
			Promise.all(
				keys
					.filter((key) => key !== CACHE_NAME && key !== META_CACHE_NAME)
					.map((key) => caches.delete(key)),
			)),
	);
	self.clients.claim();
});

self.addEventListener("message", (event) => {
	const data = event.data;
	if (!data || data.type !== "refresh-shell") return;
	const reply = event.ports && event.ports[0];
	event.waitUntil(
		refreshAppShell()
			.then((results) => {
				if (reply) {
					reply.postMessage({
						ok: results.every((result) => result.ok),
						results,
					});
				}
			})
			.catch((err) => {
				logSw("refresh-shell:fatal", err instanceof Error ? err.message : String(err));
				if (reply) reply.postMessage({ ok: false });
			}),
	);
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname.startsWith("/cdn-cgi/")) return;
	if (request.cache === "no-store" || url.searchParams.has("__sw_refresh__")) return;

	if (url.pathname.startsWith("/api/")) {
		event.respondWith(fetch(request));
		return;
	}

	// Shell Assets & Navigation -> Stale-While-Revalidate
	const isShellAsset =
		request.mode === "navigate" ||
		APP_SHELL.includes(url.pathname) ||
		url.pathname.endsWith(".js") ||
		url.pathname.endsWith(".css") ||
		url.pathname.endsWith(".html") ||
		url.pathname.endsWith(".webmanifest");

	if (isShellAsset) {
		event.respondWith(handleStaleWhileRevalidate(request));
		return;
	}

	// 그 외 자산 (이미지 등) -> Network-First
	event.respondWith(handleNetworkFirst(request));
});
