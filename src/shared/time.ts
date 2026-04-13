// Treat naive timestamps (no timezone suffix) as KST (+09:00).
export function parseKSTDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}+09:00`;
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
