const BUFFER_TIME_EPSILON = 0.075;
const TRIM_HYSTERESIS_SECONDS = 0.25;

export function waitForIdle(sb: SourceBuffer, timeoutMs = 5000): Promise<void> {
  if (!sb.updating) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sb.removeEventListener("updateend", ok);
      sb.removeEventListener("error", fail);
      reject(new Error("SourceBuffer update timed out"));
    }, timeoutMs);
    const done = (fn: () => void) => () => {
      clearTimeout(timer);
      sb.removeEventListener("updateend", ok);
      sb.removeEventListener("error", fail);
      fn();
    };
    const ok = done(resolve);
    const fail = done(() => reject(new Error("SourceBuffer error")));
    sb.addEventListener("updateend", ok, { once: true });
    sb.addEventListener("error", fail, { once: true });
  });
}

export async function appendBuffer(sb: SourceBuffer, data: Uint8Array): Promise<void> {
  await waitForIdle(sb);
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => () => {
      sb.removeEventListener("updateend", ok);
      sb.removeEventListener("error", fail);
      fn();
    };
    const ok = done(resolve);
    const fail = done(() => reject(new Error("appendBuffer failed")));
    sb.addEventListener("updateend", ok, { once: true });
    sb.addEventListener("error", fail, { once: true });
    sb.appendBuffer(data as BufferSource);
  });
}

export async function removeBuffer(sb: SourceBuffer, start: number, end: number): Promise<void> {
  await waitForIdle(sb);
  if (start >= end) return;
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => () => {
      sb.removeEventListener("updateend", ok);
      sb.removeEventListener("error", fail);
      fn();
    };
    const ok = done(resolve);
    const fail = done(() => reject(new Error("removeBuffer failed")));
    sb.addEventListener("updateend", ok, { once: true });
    sb.addEventListener("error", fail, { once: true });
    sb.remove(start, end);
  });
}

export async function trimBuffer(
  sb: SourceBuffer,
  keepStart: number,
  keepEnd: number,
): Promise<void> {
  try {
    const len = sb.buffered.length;
    if (len === 0) return;
    const totalStart = sb.buffered.start(0);
    const totalEnd = sb.buffered.end(len - 1);
    if (totalStart < keepStart - TRIM_HYSTERESIS_SECONDS)
      await removeBuffer(sb, totalStart, Math.min(keepStart, totalEnd));
    if (totalEnd > keepEnd + TRIM_HYSTERESIS_SECONDS)
      await removeBuffer(sb, Math.max(keepEnd, totalStart), totalEnd);
  } catch (e) {
    console.error("[PLAYER] trimBuffer failed:", e);
  }
}

export function isTimeInBuffer(sb: SourceBuffer, t: number): boolean {
  try {
    for (let i = 0; i < sb.buffered.length; i++) {
      if (sb.buffered.start(i) <= t + BUFFER_TIME_EPSILON && sb.buffered.end(i) >= t - BUFFER_TIME_EPSILON) return true;
    }
  } catch (e) {
    console.error("[PLAYER] buffered membership check failed:", e);
    return false;
  }
  return false;
}

export function getBufferedEnd(sb: SourceBuffer, time: number): number {
  let end = time;
  try {
    for (let i = 0; i < sb.buffered.length; i++) {
      if (sb.buffered.start(i) <= time + BUFFER_TIME_EPSILON && sb.buffered.end(i) > end)
        end = sb.buffered.end(i);
    }
  } catch (e) {
    console.error("[PLAYER] bufferedEnd:", e);
  }
  return end;
}
