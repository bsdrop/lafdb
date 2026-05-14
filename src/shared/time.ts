// Treat naive timestamps (no timezone suffix) as KST (+09:00).
export function parseKSTDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}+09:00`; // TODO: FIXME?
  return new Date(iso);
}

export function formatDateTimeKo(value: string | null | undefined): string {
  const d = parseKSTDate(value);
  if (!d) return "";
  return d.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatRelativeTimeKo(value: string | null | undefined): string {
  const d = parseKSTDate(value);
  if (!d) return "";
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "방금 전";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}일 전`;
  const month = Math.floor(day / 30.5);
  if (month < 12) return `${month}개월 전`;
  return `${Math.floor(month / 12)}년 전`;
}

// "0:04:43.300000" or "0:44:00" -> "44분" / "1시간 23분"
export function formatRuntimeKo(rt: string | null | undefined): string {
  if (!rt) return "";
  const parts = rt.split(":").map(parseFloat);
  let hours = 0;
  let minutes = 0;
  if (parts.length === 3) {
    hours = parts[0];
    minutes = Math.round(parts[1] + parts[2] / 60);
  } else if (parts.length === 2) {
    minutes = Math.round(parts[0] * 60 + parts[1]);
  }
  if (minutes >= 60) {
    hours += Math.floor(minutes / 60);
    minutes %= 60;
  }
  if (hours > 0 && minutes > 0) return `${hours}시간 ${minutes}분`;
  if (hours > 0) return `${hours}시간`;
  if (minutes > 0) return `${minutes}분`;
  return "";
}

// Parse share time strings into seconds (truncated to 4 decimal places).
// Supports formats like:
//  - "1:02:03.456"
//  - "12:34.567"
//  - "12m34s", "12m34.567s", "0h1m02s"
//  - "12.3456" (seconds)
export function parseShareTime(s: string | null | undefined): number | null {
  if (!s) return null;
  s = s.trim();
  if (s === "") return null;

  // Colon formats
  if (s.includes(":")) {
    const parts = s.split(":");
    if (parts.length === 3) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const sec = parseFloat(parts[2]);
      if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(sec)) return null;
      const total = h * 3600 + m * 60 + sec;
      return Math.trunc(total * 10000) / 10000;
    }
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10);
      const sec = parseFloat(parts[1]);
      if (!Number.isFinite(m) || !Number.isFinite(sec)) return null;
      const total = m * 60 + sec;
      return Math.trunc(total * 10000) / 10000;
    }
    return null;
  }

  // Number+unit runs. Accept tokens where unit may be omitted (then treat as seconds).
  const re = /(\d+(?:\.\d+)?)([hms]?)/gi;
  let match: RegExpExecArray | null;
  let any = false;
  let total = 0;
  let prevEnd = -1;
  let prevUnit = "";
  while ((match = re.exec(s)) !== null) {
    const val = parseFloat(match[1]);
    if (!Number.isFinite(val)) continue;
    const unit = (match[2] || "").toLowerCase();
    const start = match.index ?? -1;
    const end = start + match[0].length;
    any = true;

    // If this token has no unit and immediately follows a seconds token
    // with no separator (e.g. "3s456"), treat it as milliseconds.
    if (unit === "" && prevUnit === "s" && prevEnd === start) {
      total += val / 1000;
    } else if (unit === "h") {
      total += val * 3600;
    } else if (unit === "m") {
      total += val * 60;
    } else {
      // seconds or no unit
      total += val;
    }

    prevUnit = unit;
    prevEnd = end;
  }
  if (any) return Math.trunc(total * 10000) / 10000;

  // Fallback: plain numeric seconds
  const f = parseFloat(s);
  if (Number.isFinite(f)) return Math.trunc(f * 10000) / 10000;
  return null;
}

// Format seconds for inclusion in URL; truncate to 4 decimal places,
// remove trailing zeros and limit length to 25 chars.
export function formatShareTimeForUrl(seconds: number): string {
  const truncated = Math.trunc(seconds * 10000) / 10000;
  let s = String(truncated);
  if (s.indexOf('.') !== -1) {
    s = s.replace(/\.0+$/, '');
    s = s.replace(/(\.[0-9]*?)0+$/, '$1');
    s = s.replace(/\.$/, '');
  }
  if (s.length > 25) s = s.slice(0, 25).replace(/\.$/, '');
  return s;
}
