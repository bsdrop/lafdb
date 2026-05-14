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

export function timeToSegmentNumber(
  timeline: SegmentEntry[],
  timescale: number,
  startNumber: number,
  time: number,
): number {
  for (let i = 0; i < timeline.length; i++) {
    const seg = timeline[i];
    const start = seg.time / timescale;
    const end = (seg.time + seg.duration) / timescale;
    if (time >= start && time < end) return startNumber + i;
    if (time < start) return Math.max(startNumber, startNumber + i - 1);
  }
  return startNumber + timeline.length - 1;
}

// Returns true when segStart falls in the interior of a skip range relative
// to the current playhead ct ㅡ i.e., the player hasn't reached the range yet
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
