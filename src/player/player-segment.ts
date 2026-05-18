export type SegmentEntry = { time: number; duration: number };
export type SkipRange = { start: number; end: number };

export function parseSegmentTimeline(template: Element): SegmentEntry[] | null {
  const timeline = template.querySelector("SegmentTimeline");
  if (!timeline) return null;
  const segments: SegmentEntry[] = [];
  let currentTime = 0;
  for (const s of timeline.querySelectorAll("S")) {
    const t = s.getAttribute("t");
    const d = parseInt(s.getAttribute("d")!, 10);
    const r = parseInt(s.getAttribute("r") || "0", 10);
    if (t !== null) currentTime = parseInt(t, 10);
    for (let i = 0; i <= r; i++) {
      segments.push({ time: currentTime, duration: d });
      currentTime += d;
    }
  }
  return segments;
}

export function segmentNumberToTimeRange(
  timeline: SegmentEntry[],
  timescale: number,
  startNumber: number,
  segNum: number,
): { start: number; end: number; duration: number } | null {
  const index = segNum - startNumber;
  if (index < 0 || index >= timeline.length) return null;
  const seg = timeline[index];
  return {
    start: seg.time / timescale,
    end: (seg.time + seg.duration) / timescale,
    duration: seg.duration / timescale,
  };
}

// fetchLoop가 100ms마다 트랙별로 호출하므로 timeline이 수천 개면 누적 부담이 커진다.
// 이진탐색으로 O(log n).
export function timeToSegmentNumber(
  timeline: SegmentEntry[],
  timescale: number,
  startNumber: number,
  time: number,
): number {
  const n = timeline.length;
  if (n === 0) return startNumber;
  const target = time * timescale;
  // 경계 빠르게: 첫 세그먼트보다 이전이면 첫 세그먼트, 마지막보다 이후면 마지막.
  if (target < timeline[0].time) return startNumber;
  const last = timeline[n - 1];
  if (target >= last.time + last.duration) return startNumber + n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const seg = timeline[mid];
    if (target < seg.time) hi = mid - 1;
    else if (target >= seg.time + seg.duration) lo = mid + 1;
    else return startNumber + mid;
  }
  // 어느 세그먼트 범위에도 정확히 안 들어가는 경우(드물게 갭) — 직전 세그먼트로 클램프.
  return startNumber + Math.max(0, hi);
}

// Returns true when segStart falls in the interior of a skip range relative
// to the current playhead ct. i.e. the player hasn't reached the range yet
// but the segment is more than one segment-width past the range's start.
// Used by the fetch loop to avoid buffering OP/ED content that will be skipped.
export function isInSkipInterior(
  skipRanges: SkipRange[],
  ct: number,
  segStart: number,
  segDuration: number,
): boolean {
  return skipRanges.some(
    ({ start, end }) => ct < start && segStart >= start + segDuration && segStart < end,
  );
}
