function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function getCurrentMirrorRootHost(): string | null {
  if (typeof location === "undefined") return null;
  const host = location.hostname.toLowerCase().replace(/\.+$/g, "");
  if (!host) return null;
  // If we are on a known laftel domain, we don't have a mirror root to apply to others
  if (host.endsWith(".laftel.net") || host === "laftel.net") return null;
  // Strip common subdomains to get the root
  return host.replace(/^(?:www|app|mediacloud|streaming-bp|thumbnail)\./, "");
}

export function rewriteCdnUrl(url: string): string {
  if (!url) return url ?? "";

  let parsed: URL;
  try {
    parsed = new URL(url, typeof location !== "undefined" ? location.href : "https://laftel.net/");
  } catch {
    return url;
  }

  const hostname = parsed.hostname.toLowerCase();
  const mirrorRoot = getCurrentMirrorRootHost();
  const sourceMatch = hostname.match(/^(?<subdomain>.+?)\.(?:laftel|latfel)\.net$/);

  if (!sourceMatch?.groups?.subdomain) {
    return parsed.toString();
  }

  const subdomain = sourceMatch.groups.subdomain;

  if (mirrorRoot) {
    parsed.hostname = `${subdomain}.${mirrorRoot}`;
    if (typeof location !== "undefined") {
      if (/^https?:$/.test(location.protocol)) {
        parsed.protocol = location.protocol;
      }
      if (location.port) {
        parsed.port = location.port;
      }
    }
    return parsed.toString();
  }

  // Fallback if we can't determine mirror root (e.g. not in browser or on localhost)
  // We keep it as .latfel.net or whatever the original was if it wasn't .laftel.net
  if (hostname.endsWith(".laftel.net")) {
    parsed.hostname = `${subdomain}.latfel.net`;
  }
  return parsed.toString();
}
