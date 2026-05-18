import { decryptSegment as decryptPlayerSegment, stripDrmSignaling as stripPlayerDrmSignaling } from "./player-drm";
import {
  waitForIdle as sbWaitForIdle,
  appendBuffer as sbAppendBuffer,
  removeBuffer as sbRemoveBuffer,
  trimBuffer as sbTrimBuffer,
  isTimeInBuffer as sbIsTimeInBuffer,
  getBufferedEnd as sbGetBufferedEnd,
} from "./player-source-buffer";
import {
  parseSegmentTimeline as parseSegmentTimelineFn,
  segmentNumberToTimeRange as segmentNumberToTimeRangeFn,
  timeToSegmentNumber as timeToSegmentNumberFn,
  isInSkipInterior,
} from "./player-segment";
import type { SkipRange } from "./player-segment";

declare const ManagedMediaSource:
  | (typeof MediaSource & {
      canConstructInDedicatedWorker?: boolean;
      handle?: unknown;
    })
  | undefined;

type MediaSourceLike = typeof MediaSource;
const MS: MediaSourceLike | undefined =
  typeof ManagedMediaSource !== "undefined"
    ? (ManagedMediaSource as MediaSourceLike)
    : typeof MediaSource !== "undefined"
      ? MediaSource
      : undefined;

function isAnonymousNetworkPage(): boolean {
  const loc = (globalThis as { location?: Location }).location;
  if (!loc?.hostname) return false;
  const host = loc.hostname.toLowerCase().replace(/\.$/, "");
  return host.endsWith(".onion") || host.endsWith(".i2p");
}

interface Track {
  type: string;
  repId: string;
  mime: string;
  initUrl: string;
  mediaPattern: string;
  startNumber: number;
  timescale: number;
  presentationTimeOffset: number;
  timeline: Array<{ time: number; duration: number }> | null;
  bandwidth: number;
  width?: number;
  height?: number;
  lang?: string;
  id?: string;
  codecs?: string;
  sb: SourceBuffer | null;
  sbToken: number;
  appended: Set<number>;
  inflight: Set<number>;
  inflightAcs: Map<number, AbortController>;
  initData: Uint8Array | null;
  pruneTimer: ReturnType<typeof setTimeout> | null;
  pruneAbort: AbortController | null;
  tracks?: Track[];
}

interface QualityOption {
  id: string;
  label: string;
}

interface WorkerMessage {
  type: string;
  mpdUrl?: string;
  kid?: string;
  key?: string;
  resumeTime?: number | null;
  currentTime?: number;
  readyState?: number;
  videoWidth?: number;
  videoHeight?: number;
  repId?: string;
  buffer?: ArrayBuffer;
  id?: number;
  trackType?: string;
  message?: string;
  options?: QualityOption[];
  activeId?: string;
  time?: number;
  code?: number;
  qualityPref?: string;
  qualityPrefBps?: string;
}

const ANONYMOUS_NETWORK_CODEC_MESSAGE =
  "현재 브라우저에서 H.264/AAC 재생을 지원하지 않습니다. Brave의 Tor 비공개 창을 사용하시거나, 로컬 프록시를 통해 일반 브라우저로 접속해주시기 바랍니다.";

// 디버그 로깅 게이트. 보급형 디바이스에서 매 timeupdate/fetchLoop poll마다 발생하는
// console.log + console-log-store 가로채기가 누적 frame drop의 원인.
// localStorage.player_debug = "on" 일 때만 활성. warn/error는 항상 출력.
const _DEBUG_PLAYER =
  typeof localStorage !== "undefined" && (() => {
    try {
      return localStorage.getItem("player_debug") === "on";
    } catch {
      return false;
    }
  })();
function plog(...args: unknown[]): void {
  if (_DEBUG_PLAYER) plog(...args);
}

interface XmlNode {
  tagName: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  getAttribute(name: string): string | null;
  querySelector(tag: string): XmlNode | null;
  querySelectorAll(tag: string): XmlNode[];
}

declare const WorkerGlobalScope: any;

interface DedicatedWorkerGlobalScope extends EventTarget {
  postMessage(message: any, transfer?: Transferable[]): void;
}

class Player {
  static DEFAULT_BUFFER_AHEAD = 40;
  static DEFAULT_BUFFER_BEHIND = 30;
  static DEFAULT_BUFFER_PRUNE_DELAY_SECONDS = 0;
  static MIN_BUFFER_SECONDS = 18;
  static MAX_BUFFER_SECONDS = 300;

  _video: HTMLVideoElement | null;
  ms: MediaSource | null;
  key: CryptoKey | null;
  kid: Uint8Array | null;
  tracks: Track[];
  generation: number;
  abortControllers: Set<AbortController>;
  started: boolean;
  BUFFER_AHEAD_MAX: number;
  BUFFER_BEHIND_KEEP: number;
  BUFFER_PRUNE_DELAY_MS: number;
  POLL_INTERVAL: number;
  lastSeekTime: number;
  seekDebounceMs: number;
  seekInProgress: boolean;
  _seekTimeout: ReturnType<typeof setTimeout> | null;
  videoReps: Track[];
  activeVideoRepId: string | null;
  _recovering: boolean;
  _qualitySelectSetup: boolean;
  _ct: number;
  _rs: number;
  _vw: number;
  _vh: number;
  _ctUpdatedAt: number;
  _stallWatchdogTimer: ReturnType<typeof setTimeout> | null;
  _stallStartTimer: ReturnType<typeof setTimeout> | null;
  _pendingResumeTime: number | null;
  _stallSnapshotTime: number | null;
  _stallSnapshotBuf: number | null;
  _stallCheckCount: number;
  _nudgeCount: number;
  _autoplayBlocked: boolean;
  _lastKnownGoodTime: number | null;
  _lastKnownGoodAt: number;
  _expectBrowserResetUntil: number;
  _internalSeek: boolean;
  _gapCandidateStart: number;
  _reinitInProgress: boolean;
  _endOfStreamCalled: boolean;
  _baseUrl: string;
  _onOnline: (() => void) | null;
  _errorStreak: number;
  _lastErrorTime: number | undefined;
  _seekSettledAt: number | undefined;
  _qualityPref: number;
  _qualityPrefBps: number;
  _lastReinitAt: number;
  _lastReinitTime: number | null;
  _mpdUrl: string;
  _keyHex: string;
  _loggedDecryptLayoutWarning: boolean;
  _isFirefox: boolean;
  _compatWarningShown: boolean;
  _eventAc: AbortController | null;
  _destroyed: boolean;
  _awaitingUserPlay: boolean;
  _qualitySwitchInFlight: boolean;
  _pendingVideoRepId: string | null;
  _objectUrl: string | null;
  skipRanges: SkipRange[];
  _resumeInProgress: boolean;
  _pendingResumeSetAt: number;
  _queuedSeekTime: number | null;
  _lastExplicitTargetTime: number;
  _lastExplicitTargetAt: number;

  static _readBufferPref(key: string, fallback: number): number {
    const ls = typeof localStorage !== "undefined" ? localStorage : null;
    const raw = parseInt(ls?.getItem(key) || String(fallback), 10);
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(Player.MIN_BUFFER_SECONDS, Math.min(Player.MAX_BUFFER_SECONDS, raw));
  }

  static _readNonNegativeNumberPref(key: string, fallback: number): number {
    const ls = typeof localStorage !== "undefined" ? localStorage : null;
    const raw = parseInt(ls?.getItem(key) || String(fallback), 10);
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(0, raw);
  }

  constructor(video: HTMLVideoElement | null = null) {
    this._video = video;

    this.ms = null;
    this.key = null;
    this.kid = null;
    this.tracks = [];
    this.generation = 0;
    this.abortControllers = new Set();
    this.started = false;

    this.BUFFER_AHEAD_MAX = Player._readBufferPref("player_buffer_ahead", Player.DEFAULT_BUFFER_AHEAD);
    this.BUFFER_BEHIND_KEEP = Player._readBufferPref("player_buffer_behind", Player.DEFAULT_BUFFER_BEHIND);
    this.BUFFER_PRUNE_DELAY_MS =
      Player._readNonNegativeNumberPref("player_buffer_prune_delay", Player.DEFAULT_BUFFER_PRUNE_DELAY_SECONDS) * 1000;
    this.POLL_INTERVAL = 100;

    this.lastSeekTime = -1;
    this.seekDebounceMs = 50;
    this.seekInProgress = false;
    this._seekTimeout = null;

    this.videoReps = [];
    this.activeVideoRepId = null;
    this._recovering = false;
    this._qualitySelectSetup = false;

    this._ct = 0;
    this._rs = 0;
    this._vw = 0;
    this._vh = 0;
    this._ctUpdatedAt = 0;

    this._stallWatchdogTimer = null;
    this._stallStartTimer = null;
    this._pendingResumeTime = null;
    this._stallSnapshotTime = null;
    this._stallSnapshotBuf = null;
    this._stallCheckCount = 0;
    this._nudgeCount = 0;
    this._autoplayBlocked = false;

    this._lastKnownGoodTime = null;
    this._lastKnownGoodAt = 0;

    this._expectBrowserResetUntil = 0;
    this._internalSeek = false;
    this._gapCandidateStart = -1;
    this._reinitInProgress = false;
    this._endOfStreamCalled = false;
    this._baseUrl = "";
    this._onOnline = null;
    this._errorStreak = 0;
    this._lastErrorTime = undefined;
    this._seekSettledAt = undefined;
    this._qualityPref = 0;
    this._qualityPrefBps = 0;
    this._lastReinitAt = 0;
    this._lastReinitTime = null;
    this._mpdUrl = "";
    this._keyHex = "";
    this._loggedDecryptLayoutWarning = false;
    this._isFirefox =
      typeof navigator !== "undefined" &&
      (navigator.userAgent.includes("Firefox") || navigator.userAgent.includes("Waterfox"));
    this._compatWarningShown = false;
    this._eventAc = null;
    this._destroyed = false;
    this._awaitingUserPlay = false;
    this._qualitySwitchInFlight = false;
    this._pendingVideoRepId = null;
    this._objectUrl = null;
    this.skipRanges = [];
    this._resumeInProgress = false;
    this._pendingResumeSetAt = 0;
    this._queuedSeekTime = null;
    this._lastExplicitTargetTime = -1;
    this._lastExplicitTargetAt = 0;
  }

  get _currentTime(): number {
    if (this._video) {
      const vct = this._video.currentTime;
      if (this._pendingResumeTime != null) {
        if (this._maybeClearPendingResume(vct)) return vct;
        return this._pendingResumeTime;
      }
      if (vct > 0) return vct;
      if (this._lastKnownGoodTime != null) return this._lastKnownGoodTime;
      return vct;
    }
    return this._ct;
  }
  get _readyState(): number {
    return this._video ? this._video.readyState : this._rs;
  }
  get _videoWidth(): number {
    return this._video ? this._video.videoWidth : this._vw;
  }
  get _videoHeight(): number {
    return this._video ? this._video.videoHeight : this._vh;
  }

  // Authoritative "what position should we resume to" calculation.
  // Priority: not-yet-reached pendingResume > live video time > last known good > raw fallback.
  // Never returns a misleading 0 just because the video element hasn't seeked yet.
  _safeCurrentTime(): number {
    if (this._video) {
      const vct = this._video.currentTime;
      if (this._pendingResumeTime != null && !this._maybeClearPendingResume(vct)) {
        return this._pendingResumeTime;
      }
      if (vct > 0) return vct;
      if (this._lastKnownGoodTime != null) return this._lastKnownGoodTime;
      return vct;
    }
    if (this._pendingResumeTime != null) return this._pendingResumeTime;
    if (this._ct > 0) return this._ct;
    if (this._lastKnownGoodTime != null) return this._lastKnownGoodTime;
    return this._ct;
  }

  _now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  _setPendingResumeTime(time: number): void {
    this._pendingResumeTime = Math.max(0, time);
    this._pendingResumeSetAt = this._now();
  }

  _clearPendingResumeTime(): void {
    this._pendingResumeTime = null;
    this._pendingResumeSetAt = 0;
  }

  _rememberExplicitTarget(time: number): void {
    this._lastExplicitTargetTime = Math.max(0, time);
    this._lastExplicitTargetAt = this._now();
  }

  _maybeClearPendingResume(videoTime: number): boolean {
    if (this._pendingResumeTime == null) return true;
    // Cleared once the video has reached or passed the target.
    // No time-based expiration: slow networks must be allowed to take as long as they need.
    if (videoTime >= this._pendingResumeTime - Player.AUTO_TIME_EPSILON) {
      this._clearPendingResumeTime();
      return true;
    }
    return false;
  }

  _wasRecentUserSeekNearTail(currentTime: number, duration: number): boolean {
    if (!Number.isFinite(duration) || duration <= 0) return false;
    if (this._seekSettledAt === undefined || this.lastSeekTime < 0) return false;
    const remainingAtSeek = duration - this.lastSeekTime;
    if (remainingAtSeek <= Player.AUTO_TIME_EPSILON || remainingAtSeek > Player.FIREFOX_TAIL_DECODE_EOF_SECONDS) {
      return false;
    }
    return this._now() - this._seekSettledAt < 5000 && Math.abs(currentTime - this.lastSeekTime) <= 0.25;
  }

  _hasExplicitTailResumeIntent(currentTime: number, duration: number): boolean {
    if (!Number.isFinite(duration) || duration <= 0) return false;
    if (this._wasRecentUserSeekNearTail(currentTime, duration)) return true;
    if (this._lastExplicitTargetTime >= 0 && this._now() - this._lastExplicitTargetAt < 10000) {
      const remainingAtTarget = duration - this._lastExplicitTargetTime;
      if (
        remainingAtTarget > Player.AUTO_TIME_EPSILON &&
        remainingAtTarget <= Player.FIREFOX_TAIL_DECODE_EOF_SECONDS &&
        Math.abs(currentTime - this._lastExplicitTargetTime) <= 0.25
      ) {
        return true;
      }
    }
    if (this._pendingResumeTime == null) return false;
    const remainingAtResume = duration - this._pendingResumeTime;
    if (remainingAtResume <= Player.AUTO_TIME_EPSILON || remainingAtResume > Player.FIREFOX_TAIL_DECODE_EOF_SECONDS) {
      return false;
    }
    return this._now() - this._pendingResumeSetAt < 10000 && Math.abs(currentTime - this._pendingResumeTime) <= 0.25;
  }

  _emitCompatibilityWarning(reason: "decode" | "stall" | "anonymous-codec"): void {
    if (this._compatWarningShown) return;
    if (reason !== "anonymous-codec" && !this._isFirefox) return;
    this._compatWarningShown = true;
    const detail = {
      reason,
      message:
        reason === "anonymous-codec"
          ? ANONYMOUS_NETWORK_CODEC_MESSAGE
          : "Firefox에서는 영상이 자주 멈출 수 있습니다. Chrome 계열 브라우저로 보시거나, 다운로드 후 재생하실 것을 권장드립니다.",
    };
    try {
      if (IS_WORKER) {
        (self as unknown as DedicatedWorkerGlobalScope).postMessage({
          type: "compatWarning",
          message: detail.message,
        });
      } else {
        self.dispatchEvent(new CustomEvent("player:compat-warning", { detail }));
      }
    } catch (e) {
      console.error("[PLAYER] compat warning dispatch failed:", e);
    }
  }

  _emitGapJump(): void {
    const detail = { mpdUrl: this._mpdUrl, keyHex: this._keyHex };
    try {
      if (IS_WORKER) {
        (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: "gapJump", ...detail });
      } else {
        self.dispatchEvent(new CustomEvent("player:gap-jump", { detail }));
      }
    } catch (e) {
      console.error("[PLAYER] gap jump dispatch failed:", e);
    }
  }

  _recordGoodTime(t: number): void {
    if (t > 0.5) {
      this._lastKnownGoodTime = t;
      this._lastKnownGoodAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    }
  }

  _play(): void {
    if (this._video) {
      this._video
        .play()
        .then(() => {
          this._autoplayBlocked = false;
          this._awaitingUserPlay = false;
          if (!this.seekInProgress && this._stallWatchdogTimer === null) {
            this._startStallWatchdog();
          }
        })
        .catch((e: Error) => {
          console.error("[PLAYER] play() rejected:", e);
          if (e.name === "NotAllowedError") {
            this._autoplayBlocked = true;
            this._awaitingUserPlay = true;
            this._clearStallWatchdog();
            try {
              self.dispatchEvent(new CustomEvent("player:play-blocked"));
            } catch (dispatchError) {
              console.error("[PLAYER] player:play-blocked dispatch failed:", dispatchError);
            }
          }
        });
    } else {
      (self as unknown as DedicatedWorkerGlobalScope).postMessage({
        type: "play",
      });
    }
  }

  _seekTo(time: number): void {
    if (this._video) this._video.currentTime = time;
    else
      (self as unknown as DedicatedWorkerGlobalScope).postMessage({
        type: "setCurrentTime",
        time,
      });
  }

  _attachMediaSource(ms: MediaSource): void {
    this.started = false;
    this._expectBrowserResetUntil = Date.now() + 1500;
    if (this._video) {
      const nextUrl = URL.createObjectURL(ms);
      const prevUrl = this._objectUrl;
      this._objectUrl = nextUrl;
      try {
        this._video.pause();
      } catch (e) {
        console.error("[PLAYER] pause before source attach failed:", e);
      }
      try {
        this._video.removeAttribute("src");
        this._video.srcObject = null;
        this._video.load();
      } catch (e) {
        console.error("[PLAYER] clearing previous media source failed:", e);
      }
      this._video.src = nextUrl;
      if (prevUrl) {
        // 일부 Chromium에서 src 설정 직후 같은 microtask에서 prev URL을 revoke하면
        // 새 nextUrl까지 같이 무효화되는 케이스가 보고된 바 있다. 다음 task로 미룬다.
        setTimeout(() => {
          try {
            URL.revokeObjectURL(prevUrl);
          } catch (e) {
            console.error("[PLAYER] revokeObjectURL failed:", e);
          }
        }, 0);
      }
    } else {
      const msWithHandle = ms as MediaSource & { handle?: unknown };
      const handle = msWithHandle.handle;
      (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: "handle", handle }, [handle as Transferable]);
    }
  }

  _sendQualityOptions(options: QualityOption[], activeId: string | null): void {
    if (this._video) {
      const sel = document.getElementById("quality-selector");
      if (!sel) return;
      sel.innerHTML = "";
      for (const opt of options) {
        const el = document.createElement("option");
        el.value = opt.id;
        el.textContent = opt.label;
        if (opt.id === activeId) el.selected = true;
        sel.appendChild(el);
      }
      if (!this._qualitySelectSetup) {
        (sel as HTMLSelectElement).addEventListener("change", () => {
          if ((sel as HTMLSelectElement).value && (sel as HTMLSelectElement).value !== this.activeVideoRepId)
            this._switchVideoRep((sel as HTMLSelectElement).value);
        });
        this._qualitySelectSetup = true;
      }
    } else {
      (self as unknown as DedicatedWorkerGlobalScope).postMessage({
        type: "qualityOptions",
        options,
        activeId,
      });
    }
  }

  _updateQualitySelector(): void {
    if (this._video) {
      const sel = document.getElementById("quality-selector") as HTMLSelectElement | null;
      if (sel) for (const opt of sel.options) opt.selected = opt.value === this.activeVideoRepId;
    } else {
      (self as unknown as DedicatedWorkerGlobalScope).postMessage({
        type: "updateActiveQuality",
        repId: this.activeVideoRepId,
      });
    }
  }

  hexToUint8(hex: string): Uint8Array {
    if (!hex || hex.length % 2 !== 0) throw new Error("Invalid hex string");
    return new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  }

  wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  _invalidateTrackSb(track: Track): void {
    track.sbToken++;
    track.sb = null;
  }

  _bumpTrackSbToken(track: Track): void {
    track.sbToken++;
  }

  _getLiveTrackSb(track: Track, token?: number): SourceBuffer | null {
    if (!track.sb) return null;
    if (token !== undefined && token !== track.sbToken) return null;
    return track.sb;
  }

  _bufferedEndForTrack(track: Track, time: number): number {
    const sb = this._getLiveTrackSb(track);
    if (!sb) return time;
    return this.getBufferedEnd(sb, time);
  }

  _trackTimeInBuffer(track: Track | null | undefined, time: number): boolean {
    if (!track) return false;
    const sb = this._getLiveTrackSb(track);
    if (!sb) return false;
    return this.isTimeInBuffer(sb, time);
  }

  async _appendToTrack(track: Track, token: number, data: Uint8Array): Promise<boolean> {
    const sb = this._getLiveTrackSb(track, token);
    if (!sb || this._destroyed) return false;
    await this.appendBuffer(sb, data);
    return !!this._getLiveTrackSb(track, token);
  }

  async _removeFromTrack(track: Track, token: number, start: number, end: number): Promise<boolean> {
    const sb = this._getLiveTrackSb(track, token);
    if (!sb || this._destroyed) return false;
    await this.removeBuffer(sb, start, end);
    return !!this._getLiveTrackSb(track, token);
  }

  async _trimTrackBuffer(track: Track, token: number, keepStart: number, keepEnd: number): Promise<boolean> {
    const sb = this._getLiveTrackSb(track, token);
    if (!sb || this._destroyed) return false;
    await this.trimBuffer(sb, keepStart, keepEnd);
    return !!this._getLiveTrackSb(track, token);
  }

  _cancelTrackPrune(track: Track): void {
    track.pruneAbort?.abort();
    if (track.pruneTimer) clearTimeout(track.pruneTimer);
    track.pruneAbort = null;
    track.pruneTimer = null;
  }

  async _pruneTrackBehind(track: Track, token: number, keepStart: number): Promise<void> {
    try {
      await this._trimTrackBuffer(track, token, keepStart, Infinity);
      this._pruneAppended(track);
    } catch (e) {
      console.error(`[${track.type.toUpperCase()}] prune behind failed:`, e);
    }
  }

  _schedulePruneTrackBehind(track: Track, token: number, keepStart: number): void {
    if (this.BUFFER_PRUNE_DELAY_MS <= 0) {
      void this._pruneTrackBehind(track, token, keepStart);
      return;
    }
    if (track.pruneTimer) return;

    const ac = new AbortController();
    track.pruneAbort = ac;
    const timer = setTimeout(() => {
      if (ac.signal.aborted) return;
      track.pruneTimer = null;
      track.pruneAbort = null;
      if (this._destroyed || token !== track.sbToken) return;
      void this._pruneTrackBehind(track, token, keepStart);
    }, this.BUFFER_PRUNE_DELAY_MS);
    track.pruneTimer = timer;
    ac.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        if (track.pruneTimer === timer) track.pruneTimer = null;
        if (track.pruneAbort === ac) track.pruneAbort = null;
      },
      { once: true },
    );
  }

  waitOrOnline(ms: number): Promise<void> {
    return new Promise((r) => {
      const timer = setTimeout(done, ms);
      function done() {
        self.removeEventListener("online", done);
        clearTimeout(timer);
        r();
      }
      self.addEventListener("online", done, { once: true });
    });
  }

  // Combines the given AbortSignal with a per-request timeout so a stalled TCP
  // connection on cell handover doesn't block the fetch loop indefinitely.
  _timedSignal(parent: AbortSignal, ms: number): AbortSignal {
    if (typeof (AbortSignal as any).any === "function") {
      return (
        AbortSignal as unknown as {
          any: (s: Iterable<AbortSignal>) => AbortSignal;
        }
      ).any([parent, AbortSignal.timeout(ms)]);
    }
    // Fallback: manual timer
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new DOMException("Timeout", "TimeoutError")), ms);
    parent.addEventListener("abort", () => {
      clearTimeout(timer);
      ac.abort(parent.reason);
    });
    return ac.signal;
  }

  _setupNetworkRecovery(): void {
    if (this._onOnline) {
      self.removeEventListener("online", this._onOnline);
      this._onOnline = null;
    }
    this._onOnline = () => {
      if (!this.started || this._recovering || this._destroyed) return;
      console.warn("[PLAYER] network online, triggering immediate recovery");
      this._reinitMediaSource(this._safeCurrentTime()).catch((e) =>
        console.error("[PLAYER] online recovery failed:", e),
      );
    };
    self.addEventListener("online", this._onOnline);
  }

  async setKey(kidHex: string, keyHex: string): Promise<void> {
    if (!kidHex || !keyHex) {
      plog("[PLAYER] No key provided, skipping DRM setup");
      return;
    }
    this.kid = this.hexToUint8(kidHex);
    this.key = await crypto.subtle.importKey(
      "raw",
      this.hexToUint8(keyHex) as BufferSource,
      { name: "AES-CTR" },
      false,
      ["decrypt"],
    );
    plog("[PLAYER] Key imported");
  }

  waitForIdle(sb: SourceBuffer, timeoutMs = 5000): Promise<void> {
    return sbWaitForIdle(sb, timeoutMs);
  }

  async appendBuffer(sb: SourceBuffer, data: Uint8Array): Promise<void> {
    return sbAppendBuffer(sb, data);
  }

  isTimeInBuffer(sb: SourceBuffer, t: number): boolean {
    return sbIsTimeInBuffer(sb, t);
  }

  async trimBuffer(sb: SourceBuffer, keepStart: number, keepEnd: number): Promise<void> {
    return sbTrimBuffer(sb, keepStart, keepEnd);
  }

  async removeBuffer(sb: SourceBuffer, start: number, end: number): Promise<void> {
    return sbRemoveBuffer(sb, start, end);
  }

  getBufferedEnd(sb: SourceBuffer, time: number): number {
    return sbGetBufferedEnd(sb, time);
  }

  static STALL_POLL_MS = 1000;
  static SEG_FETCH_TIMEOUT_MS = 20_000; // per-segment fetch timeout (cell handover guard)
  static INIT_FETCH_TIMEOUT_MS = 30_000; // init/MPD fetch timeout
  static STALL_MAX_STRIKES = 3;
  static STALL_DECODER_STRIKES = 2;
  static STALL_BUF_MIN = 0.2;
  static AUTO_TIME_EPSILON = 0.075;
  static FIREFOX_TAIL_DECODE_EOF_SECONDS = 3;
  static NUDGE_MAX = 2;
  static DECODE_RECOVERY_MAX_RETRIES = 3;

  _getVideoSb(): SourceBuffer | null {
    return this.tracks.find((t) => t.type === "video")?.sb ?? null;
  }

  _hasInflightSegments(): boolean {
    return this.tracks.some((track) => track.inflight.size > 0);
  }

  _startStallWatchdog(): void {
    this._clearStallWatchdog();
    this._stallCheckCount = 0;
    this._stallSnapshotTime = null;
    this._stallSnapshotBuf = null;
    this._scheduleStallCheck();
  }

  _scheduleStallCheck(): void {
    if (this._stallWatchdogTimer !== null) {
      clearTimeout(this._stallWatchdogTimer);
      this._stallWatchdogTimer = null;
    }
    this._stallWatchdogTimer = setTimeout(() => this._stallCheck(), Player.STALL_POLL_MS);
  }

  _stallCheck(): void {
    if (this._recovering) {
      this._scheduleStallCheck();
      return;
    }
    if (this._resumeInProgress) {
      this._scheduleStallCheck();
      return;
    }
    if (this._pendingResumeTime != null) {
      // Still seeking toward the resume target — defer stall watchdog to avoid spurious reinits at vct=0.
      this._scheduleStallCheck();
      return;
    }
    if (this._video?.ended) {
      this._clearStallWatchdog();
      return;
    }
    if (this._video?.paused && (this._autoplayBlocked || this._awaitingUserPlay)) {
      this._scheduleStallCheck();
      return;
    }
    if (this._autoplayBlocked) {
      this._scheduleStallCheck();
      return;
    }
    if (this.seekInProgress) {
      this._scheduleStallCheck();
      return;
    }

    const ct = this._safeCurrentTime();
    const rs = this._readyState;
    const vsb = this._getVideoSb();
    const bufEnd = vsb ? this.getBufferedEnd(vsb, ct) : ct;
    const ahead = bufEnd - ct;
    const asb = this.tracks.find((t) => t.type === "audio")?.sb ?? null;
    const audioBufEnd = asb ? this.getBufferedEnd(asb, ct) : bufEnd;
    const audioAhead = audioBufEnd - ct;
    const duration = this._video?.duration ?? (this.ms && Number.isFinite(this.ms.duration) ? this.ms.duration : NaN);

    if (Number.isFinite(duration) && duration > 0 && duration - ct <= Player.AUTO_TIME_EPSILON) {
      console.warn(
        `[PLAYER] near-end stall ignored (ct=${ct.toFixed(3)} / dur=${duration.toFixed(3)}), finalizing playback`,
      );
      this._clearStallWatchdog();
      this._stopFetchLoops("near-end stall");
      try {
        if (this.ms && this.ms.readyState === "open") {
          this.ms.endOfStream();
        }
      } catch (e) {
        console.error("[PLAYER] endOfStream() during stall finalize failed:", (e as Error).message);
      }
      if (this._video) {
        this._internalSeek = true;
        this._video.currentTime = Math.max(0, duration - 0.001);
      }
      return;
    }

    if (rs >= 3) {
      this._stallCheckCount = 0;
      this._nudgeCount = 0;
      this._stallSnapshotTime = ct;
      this._stallSnapshotBuf = bufEnd;
      this._scheduleStallCheck();
      return;
    }

    // Gap jumper: if stuck at a gap but there's buffer just a bit further ahead.
    // Confirm on two consecutive checks to avoid jumping over transient false gaps
    // (Firefox MSE sometimes briefly reports a gap right after a remove/append).
    if (vsb && rs === 2 && ahead < Player.AUTO_TIME_EPSILON) {
      let gapStart = -1;
      for (let i = 0; i < vsb.buffered.length; i++) {
        const start = vsb.buffered.start(i);
        if (start > ct && start - ct <= Player.AUTO_TIME_EPSILON) {
          gapStart = start;
          break;
        }
      }
      if (gapStart >= 0) {
        if (Math.abs(this._gapCandidateStart - gapStart) <= Player.AUTO_TIME_EPSILON) {
          console.warn(`[PLAYER] Gap detected, jumping to ${gapStart.toFixed(3)}s`);
          this._gapCandidateStart = -1;
          this._internalSeek = true;
          this._seekTo(gapStart);
          this._emitGapJump();
        } else {
          plog(`[PLAYER] Gap candidate ${gapStart.toFixed(3)}s, confirming next check`);
          this._gapCandidateStart = gapStart;
        }
        this._scheduleStallCheck();
        return;
      }
    }
    this._gapCandidateStart = -1;

    // If video has buffer but audio is still catching up, be patient, it's not a decoder stall.
    const audioIsBuffering = ahead >= Player.STALL_BUF_MIN && audioAhead < Player.STALL_BUF_MIN;
    const strikeLimit =
      ahead >= Player.STALL_BUF_MIN && !audioIsBuffering ? Player.STALL_DECODER_STRIKES : Player.STALL_MAX_STRIKES;

    if (ahead < Player.STALL_BUF_MIN && this._hasInflightSegments()) {
      this._stallCheckCount = 0;
      this._stallSnapshotTime = ct;
      this._stallSnapshotBuf = bufEnd;
      this._scheduleStallCheck();
      return;
    }

    const prevTime = this._stallSnapshotTime;
    const prevBuf = this._stallSnapshotBuf;
    const timeOk = prevTime !== null && ct - prevTime > 0.05;
    const bufOk = prevBuf !== null && bufEnd - prevBuf > 0.05;

    if (timeOk || bufOk) {
      this._stallCheckCount = 0;
    } else {
      this._stallCheckCount++;
      console.warn(
        `[PLAYER] stall strike ${this._stallCheckCount}/${strikeLimit}` +
          ` ct=${ct.toFixed(2)} ahead=${ahead.toFixed(2)} audioAhead=${audioAhead.toFixed(2)} rs=${rs}`,
      );
    }

    this._stallSnapshotTime = ct;
    this._stallSnapshotBuf = bufEnd;

    if (this._stallCheckCount >= strikeLimit) {
      this._stallCheckCount = 0;
      // _safeCurrentTime already enforces pendingResume > vct > lastKnownGood priority.
      const safeResume = this._safeCurrentTime();

      if (ahead < Player.STALL_BUF_MIN) {
        console.warn(`[PLAYER] stall confirmed (no buffer), reinit from ${safeResume.toFixed(2)}s`);
        if (this._isFirefox) this._emitCompatibilityWarning("stall");
        this._reinitMediaSource(safeResume).catch((e) => console.error("[PLAYER] watchdog reinit failed:", e));
        return;
      } else if (audioIsBuffering) {
        console.warn(
          `[PLAYER] audio stall (video buffer ok, audioAhead=${audioAhead.toFixed(2)}), reinitializing from ${safeResume.toFixed(2)}s`,
        );
        if (this._isFirefox) this._emitCompatibilityWarning("stall");
        this._nudgeCount = 0;
        this._reinitMediaSource(safeResume).catch((e) => console.error("[PLAYER] audio-stall reinit failed:", e));
        return;
      } else {
        if (this._nudgeCount < Player.NUDGE_MAX) {
          this._nudgeCount++;
          const nudgeTarget = Math.max(0, safeResume - 0.06);
          console.warn(
            `[PLAYER] decoder stall (buffer ok), nudging back 0.06s to ${nudgeTarget.toFixed(3)}s (nudge ${this._nudgeCount}/${Player.NUDGE_MAX})`,
          );
          this._stallCheckCount = 0;
          this._internalSeek = true;
          this._seekTo(nudgeTarget);
          this._scheduleStallCheck();
          return;
        }
        const recoveryTime = this._getDecodeRecoveryTime(safeResume);
        const retryResume = Math.min(
          recoveryTime,
          Number.isFinite(this._video?.duration) ? this._video!.duration || recoveryTime : recoveryTime,
        );
        console.warn(`[PLAYER] decoder stall (buffer ok), reinitializing from ${retryResume.toFixed(2)}s`);
        if (this._isFirefox) this._emitCompatibilityWarning("stall");
        this._nudgeCount = 0;
        this._reinitMediaSource(retryResume).catch((e) => console.error("[PLAYER] buffered-stall reinit failed:", e));
        return;
      }
    }

    this._scheduleStallCheck();
  }

  _nudgeDecoder(_ct: number): void {
    const retryResume = this._safeCurrentTime();
    console.warn(`[PLAYER] nudge path disabled, reinitializing from ${retryResume.toFixed(3)}s`);
    this._nudgeCount = 0;
    this._reinitMediaSource(retryResume).catch((e) => console.error("[PLAYER] nudge fallback reinit failed:", e));
  }

  _clearStallWatchdog(): void {
    if (this._stallStartTimer !== null) {
      clearTimeout(this._stallStartTimer);
      this._stallStartTimer = null;
    }
    if (this._stallWatchdogTimer !== null) {
      clearTimeout(this._stallWatchdogTimer);
      this._stallWatchdogTimer = null;
    }
  }

  parseSegmentTimeline(template: Element): Array<{ time: number; duration: number }> | null {
    return parseSegmentTimelineFn(template);
  }

  segmentNumberToTimeRange(track: Track, segNum: number): { start: number; end: number; duration: number } | null {
    if (!track.timeline) return null;
    return segmentNumberToTimeRangeFn(track.timeline, track.timescale, track.startNumber, segNum);
  }

  timeToSegmentNumber(track: Track, time: number): number {
    if (!track.timeline) return track.startNumber;
    return timeToSegmentNumberFn(track.timeline, track.timescale, track.startNumber, time);
  }

  _buildTrackFromRep(rep: Element, set: Element, baseUrl: string, type: string): Track | null {
    const mimeType =
      rep.getAttribute("mimeType") || set.getAttribute("mimeType") || (type === "audio" ? "audio/mp4" : "video/mp4");
    const codec =
      rep.getAttribute("codecs") ||
      set.getAttribute("codecs") ||
      (mimeType.includes("audio") ? "mp4a.40.2" : "avc1.4d401f");
    const fullMime = `${mimeType}; codecs="${codec}"`;

    const tmpl =
      Array.from(rep.children).find((c) => c.tagName === "SegmentTemplate") ||
      Array.from(set.children).find((c) => c.tagName === "SegmentTemplate") ||
      null;
    if (!tmpl) return null;
    const supported = !!MS?.isTypeSupported(fullMime);
    if (!supported && !isAnonymousNetworkPage()) return null;
    if (!supported) {
      console.warn(
        `[${type.toUpperCase()}] ${fullMime} failed isTypeSupported on anonymous network; trying SourceBuffer anyway`,
      );
    }

    const repId = rep.getAttribute("id") || "";
    const fill = (s: string) => s.replace(/\$RepresentationID\$/g, repId);
    const timescale = parseInt(tmpl.getAttribute("timescale") || "1", 10);
    const startNumber = parseInt(tmpl.getAttribute("startNumber") || "1", 10);
    const presentationTimeOffset = parseInt(tmpl.getAttribute("presentationTimeOffset") || "0", 10);
    const initUrl = baseUrl + fill(tmpl.getAttribute("initialization")!);
    const mediaPattern = baseUrl + fill(tmpl.getAttribute("media")!);
    const timeline = this.parseSegmentTimeline(tmpl);

    return {
      type,
      repId,
      mime: fullMime,
      initUrl,
      mediaPattern,
      startNumber,
      timescale,
      presentationTimeOffset,
      timeline,
      bandwidth: parseInt(rep.getAttribute("bandwidth") || "0", 10),
      width: parseInt(rep.getAttribute("width") || set.getAttribute("width") || "0", 10),
      height: parseInt(rep.getAttribute("height") || set.getAttribute("height") || "0", 10),
      sb: null,
      sbToken: 0,
      appended: new Set(),
      inflight: new Set(),
      inflightAcs: new Map(),
      initData: null,
      pruneTimer: null,
      pruneAbort: null,
    };
  }

  _parseXmlFallback(text: string): XmlNode {
    const clean = text
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\?[\s\S]*?\?>/g, "")
      .replace(/<!DOCTYPE[^>]*>/gi, "");

    const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    const TAG_RE = /<(\/?)([A-Za-z][\w:.-]*)([^>]*?)(\/?)>/g;

    const parseAttrs = (str: string): Record<string, string> => {
      if (!str || str.indexOf("=") === -1) return EMPTY_ATTRS;
      const attrs: Record<string, string> = Object.create(null);
      ATTR_RE.lastIndex = 0;
      let m;
      while ((m = ATTR_RE.exec(str)) !== null) attrs[m[1]] = m[2] ?? m[3] ?? "";
      return attrs;
    };

    const nodeProto: Omit<XmlNode, "tagName" | "attrs" | "children"> = {
      getAttribute(name: string): string | null {
        return (this as XmlNode).attrs[name] ?? null;
      },
      querySelector(tag: string): XmlNode | null {
        const stack = (this as XmlNode).children.slice().reverse();
        while (stack.length) {
          const node = stack.pop()!;
          if (node.tagName === tag) return node;
          for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
        }
        return null;
      },
      querySelectorAll(tag: string): XmlNode[] {
        const out: XmlNode[] = [],
          stack = (this as XmlNode).children.slice().reverse();
        while (stack.length) {
          const node = stack.pop()!;
          if (node.tagName === tag) out.push(node);
          for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
        }
        return out;
      },
    };

    const EMPTY_ATTRS: Record<string, string> = Object.freeze(Object.create(null)) as Record<string, string>;
    const makeNode = (tagName: string, attrs: Record<string, string> = EMPTY_ATTRS): XmlNode => {
      const node: XmlNode = Object.create(nodeProto);
      node.tagName = tagName;
      node.attrs = attrs;
      node.children = [];
      return node;
    };

    const root = makeNode("#document"),
      stack = [root];
    let m;
    while ((m = TAG_RE.exec(clean)) !== null) {
      const [, isClose, tag, attrStr, selfClose] = m;
      if (isClose) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const el = makeNode(tag, parseAttrs(attrStr));
      stack[stack.length - 1].children.push(el);
      if (!selfClose) stack.push(el);
    }
    return root;
  }

  parseMPD(text: string, baseUrl: string): Track[] {
    plog("[PLAYER] Parsing MPD...");
    let xml: Document | XmlNode;
    if (typeof DOMParser !== "undefined") {
      const parser = new DOMParser();
      xml = parser.parseFromString(text, "application/xml");
      const parseError = xml.querySelector("parsererror");
      if (parseError) console.error("[PLAYER] MPD parse error:", parseError.textContent);
    } else {
      xml = this._parseXmlFallback(text);
    }

    const sets = Array.from((xml as any).querySelectorAll("AdaptationSet"));
    const tracks: Track[] = [];
    this.videoReps = [];

    for (const set of sets) {
      const reps = Array.from((set as any).querySelectorAll("Representation"));
      if (reps.length === 0) continue;
      const contentType = String(
        ((set as any).getAttribute("contentType") || (set as any).getAttribute("type") || "") as string,
      ).toLowerCase();
      const firstMime = String(
        (reps[0] as any).getAttribute("mimeType") || (set as any).getAttribute("mimeType") || "",
      ).toLowerCase();
      const firstCodec = String(
        (reps[0] as any).getAttribute("codecs") || (set as any).getAttribute("codecs") || "",
      ).toLowerCase();
      const type =
        contentType.includes("video") ||
        firstMime.includes("video") ||
        firstCodec.startsWith("avc") ||
        firstCodec.startsWith("hev") ||
        firstCodec.startsWith("hvc")
          ? "video"
          : "audio";

      if (type === "video") {
        for (const rep of reps) {
          const track = this._buildTrackFromRep(rep as Element, set as Element, baseUrl, "video");
          if (track) this.videoReps.push(track);
        }
        this.videoReps.sort((a, b) => b.bandwidth - a.bandwidth);
        if (this.videoReps.length > 0) {
          const prefBps =
            this._qualityPrefBps ||
            (typeof localStorage !== "undefined" ? parseInt(localStorage.getItem("quality_pref_bps") || "0", 10) : 0);
          const prefHeight = !prefBps
            ? this._qualityPref ||
              (typeof localStorage !== "undefined" ? parseInt(localStorage.getItem("quality_pref") || "0", 10) : 0)
            : 0;
          plog(
            `[PLAYER] videoReps: ${this.videoReps.map((r) => `${r.repId} ${r.width}x${r.height} ${r.bandwidth}bps`).join(" | ")}`,
          );
          plog(`[PLAYER] prefHeight=${prefHeight} prefBps=${prefBps}`);
          const hasHeight = this.videoReps.some((r) => (r.height ?? 0) > 0);
          let chosen: Track;
          if (prefBps) {
            // 비트레이트 모드: bps → bps/1000 = kbps 로 비교
            const targetBps = prefBps * 1000;
            chosen = this.videoReps.reduce((best, r) =>
              Math.abs(r.bandwidth - targetBps) < Math.abs(best.bandwidth - targetBps) ? r : best,
            );
          } else if (!prefHeight) {
            chosen = this.videoReps[0];
          } else if (hasHeight) {
            chosen =
              this.videoReps.find((r) => (r.height ?? 0) > 0 && (r.height ?? 0) <= prefHeight) ?? this.videoReps[0];
          } else {
            const idx =
              prefHeight >= 1080
                ? 0
                : prefHeight >= 720
                  ? Math.min(1, this.videoReps.length - 1)
                  : Math.min(2, this.videoReps.length - 1);
            chosen = this.videoReps[idx];
          }
          this.activeVideoRepId = chosen.repId;
          tracks.push(chosen);
          plog(`[PLAYER] Default video: id=${chosen.repId} ${chosen.width}x${chosen.height}`);
        }
      } else {
        reps.sort(
          (a, b) =>
            parseInt((b as any).getAttribute("bandwidth") || "0", 10) -
            parseInt((a as any).getAttribute("bandwidth") || "0", 10),
        );
        for (const rep of reps) {
          const track = this._buildTrackFromRep(rep as Element, set as Element, baseUrl, "audio");
          if (track) {
            tracks.push(track);
            break;
          }
        }
      }
    }

    plog(`[PLAYER] Tracks: ${tracks.length}, VideoReps: ${this.videoReps.length}`);
    this._sendQualityOptions(
      this.videoReps.map((r) => ({
        id: r.repId,
        label: `${r.height}p (~${Math.round(r.bandwidth / 1000)}kbps)`,
      })),
      this.activeVideoRepId,
    );
    return tracks;
  }

  async _switchVideoRep(repId: string): Promise<void> {
    this._pendingVideoRepId = repId;
    if (this._qualitySwitchInFlight) return;
    this._qualitySwitchInFlight = true;
    try {
      while (this._pendingVideoRepId && !this._destroyed) {
        const nextRepId = this._pendingVideoRepId;
        this._pendingVideoRepId = null;
        const newRep = this.videoReps.find((r) => r.repId === nextRepId);
        if (!newRep || nextRepId === this.activeVideoRepId) continue;
        while ((this._recovering || this._reinitInProgress) && !this._destroyed) {
          await this.wait(50);
        }
        if (this._destroyed) return;
        plog(`[PLAYER] Switching video → id=${nextRepId} ${newRep.width}x${newRep.height}`);
        this.activeVideoRepId = nextRepId;
        this._updateQualitySelector();
        await this._reinitMediaSource(this._safeCurrentTime());
      }
    } finally {
      this._qualitySwitchInFlight = false;
    }
  }

  async _reinitMediaSource(resumeTime: number): Promise<void> {
    if (this._recovering) {
      this._queuedSeekTime = Math.max(0, resumeTime);
      this._setPendingResumeTime(this._queuedSeekTime);
      console.warn(`[PLAYER] Already recovering, queued reinit to ${this._queuedSeekTime.toFixed(3)}s`);
      return;
    }
    this._recovering = true;
    this._clearStallWatchdog();

    const v = this._video as
      | (HTMLVideoElement & {
          webkitPresentationMode?: string;
          webkitSetPresentationMode?: (mode: string) => void;
          fastSeek?: (t: number) => void;
          _prevWebkitMode?: string;
        })
      | null;

    const wasInPiP = v && (document.pictureInPictureElement === v || v.webkitPresentationMode === "picture-in-picture");

    const playbackState = v
      ? {
          playbackRate: v.playbackRate || 1,
          defaultPlaybackRate: v.defaultPlaybackRate || v.playbackRate || 1,
        }
      : undefined;

    const shouldResume = this._video ? !this._video.paused && !this._autoplayBlocked && !this._awaitingUserPlay : true;

    if (resumeTime == null) {
      resumeTime = this._lastKnownGoodTime ?? 0;
    }
    plog(`[PLAYER] Reinitializing MediaSource (resumeTime=${resumeTime.toFixed(3)})`);
    this._lastReinitAt = Date.now();
    this._lastReinitTime = resumeTime;

    this.generation++;
    this._endOfStreamCalled = false;
    for (const ac of this.abortControllers) ac.abort();
    this.abortControllers.clear();
    for (const track of this.tracks) {
      this._cancelTrackPrune(track);
      for (const [, ac] of track.inflightAcs) ac.abort();
      track.inflightAcs.clear();
      track.inflight.clear();
      track.appended = new Set();
      this._invalidateTrackSb(track);
    }

    const activeRep = this.videoReps.find((r) => r.repId === this.activeVideoRepId);
    if (activeRep) {
      const videoIdx = this.tracks.findIndex((t) => t.type === "video");
      if (videoIdx !== -1) {
        this._invalidateTrackSb(activeRep);
        activeRep.appended = new Set();
        activeRep.inflight = new Set();
        activeRep.inflightAcs = new Map();
        this.tracks[videoIdx] = activeRep;
      }
    }

    const ms = new MS!() as MediaSource;
    this.ms = ms;
    ms.addEventListener("sourceopen", () => plog("[PLAYER] MediaSource: sourceopen"));
    ms.addEventListener("sourceended", () => plog("[PLAYER] MediaSource: sourceended"));
    ms.addEventListener("sourceclose", () => plog("[PLAYER] MediaSource: sourceclose"));

    this._reinitInProgress = true;
    try {
      this._attachMediaSource(ms);

      await new Promise<void>((resolve, reject) => {
        ms.addEventListener(
          "sourceopen",
          () => {
            this._startPlayback(resumeTime, shouldResume, playbackState).then(resolve).catch(reject);
          },
          { once: true },
        );
      });
    } finally {
      this._reinitInProgress = false;
      this._recovering = false;
    }

    const queuedSeekTime = this._queuedSeekTime;
    this._queuedSeekTime = null;
    if (
      queuedSeekTime != null &&
      Math.abs(queuedSeekTime - resumeTime) > Player.AUTO_TIME_EPSILON &&
      !this._destroyed
    ) {
      console.warn(`[PLAYER] applying queued seek after recovery → ${queuedSeekTime.toFixed(3)}s`);
      this._clearPendingResumeTime();
      await this._reinitMediaSource(queuedSeekTime);
      return;
    }

    if (wasInPiP && v) {
      const playAfterPiP = () => {
        const tryPlay = () =>
          v.play().catch((e: Error) => {
            console.error("[PLAYER] PiP play rejected:", e);
          });
        tryPlay();
        setTimeout(() => {
          if (v.paused) tryPlay();
        }, 300);
      };
      const enterPiP = () => {
        if (v.webkitSetPresentationMode) {
          v.addEventListener("webkitpresentationmodechanged", function onMode() {
            if (v.webkitPresentationMode === "picture-in-picture") {
              v.removeEventListener("webkitpresentationmodechanged", onMode);
              playAfterPiP();
            }
          });
          try {
            v.webkitSetPresentationMode("picture-in-picture");
          } catch (e) {
            console.error("[PLAYER] webkitSetPresentationMode(picture-in-picture) failed:", e);
          }
        } else if (v.requestPictureInPicture) {
          v.requestPictureInPicture()
            .then(playAfterPiP)
            .catch((e: Error) => console.error("[PLAYER] requestPictureInPicture failed:", e));
        }
      };
      if (v.readyState >= 2) {
        enterPiP();
      } else {
        v.addEventListener("canplay", enterPiP, { once: true });
      }
    }
  }

  async _appendInit(track: Track): Promise<void> {
    if (!track.initData) {
      plog(`[${track.type.toUpperCase()}] Fetching init: ${track.initUrl}`);
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          if (attempt > 0) await this.wait(Math.min(1000 * 2 ** attempt, 15000));
          const resp = await fetch(track.initUrl, {
            signal: AbortSignal.timeout(Player.INIT_FETCH_TIMEOUT_MS),
          });
          if (!resp.ok) throw new Error(`Init fetch HTTP ${resp.status}`);
          const raw = new Uint8Array(await resp.arrayBuffer());
          track.initData = this.stripDrmSignaling(raw, track.type);
          plog(`[${track.type.toUpperCase()}] Init fetched (${track.initData.byteLength}B)`);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e as Error;
          console.warn(
            `[${track.type.toUpperCase()}] Init fetch attempt ${attempt + 1} failed: ${(e as Error).message}`,
          );
        }
      }
      if (lastErr) throw lastErr;
    } else {
      plog(`[${track.type.toUpperCase()}] Init cache hit`);
    }
    const token = track.sbToken;
    const appended = await this._appendToTrack(track, token, track.initData!);
    if (!appended) return;
    plog(`[${track.type.toUpperCase()}] Init appended`);
  }

  async init(mpdUrl: string, kid: string, key: string, resumeTime: number | null = null): Promise<void> {
    if (this._destroyed) return;
    plog("[PLAYER] Initializing");
    this._setupNetworkRecovery();

    if (this._video) {
      this._eventAc?.abort();
      this._eventAc = new AbortController();
      const signal = this._eventAc.signal;
      const videoEvents = [
        "loadstart",
        "loadedmetadata",
        "loadeddata",
        "canplay",
        "canplaythrough",
        "play",
        "playing",
        "pause",
        "ended",
        "waiting",
        "stalled",
        "suspend",
        "durationchange",
        "resize",
        "emptied",
        "abort",
        "seeked",
      ];
      for (const ev of videoEvents) {
        this._video.addEventListener(
          ev,
          () => {
            plog(
              `[VIDEO] ${ev} | ct=${this._video!.currentTime.toFixed(3)} rs=${this._video!.readyState}` +
                ` ${this._video!.videoWidth}x${this._video!.videoHeight} dur=${this._video!.duration}`,
            );
          },
          { signal },
        );
      }
      this._video.addEventListener(
        "error",
        () => {
          const ve = this._video!.error;
          console.error(
            `[VIDEO] error | ct=${this._video!.currentTime.toFixed(3)} rs=${this._video!.readyState}` +
              ` ERR code=${ve?.code} msg="${ve?.message}"`,
          );
          this._handleVideoError(ve?.code);
        },
        { signal },
      );
      this._video.addEventListener(
        "seeking",
        () => {
          this._handleSeeking(this._video!.currentTime);
        },
        { signal },
      );
      this._video.addEventListener(
        "timeupdate",
        () => {
          const ct = this._video!.currentTime;
          this._recordGoodTime(ct);
        },
        { signal },
      );
      this._video.addEventListener(
        "playing",
        () => {
          this._autoplayBlocked = false;
          this._awaitingUserPlay = false;
          this._stallCheckCount = 0;
          this._stallSnapshotTime = this._video!.currentTime;
          this._stallSnapshotBuf = null;
          if (!this.seekInProgress) this._startStallWatchdog();
        },
        { signal },
      );
    }

    this._mpdUrl = mpdUrl;
    this._keyHex = key;
    await this.setKey(kid, key);
    if (this._destroyed) return;

    let mpdText: string;
    {
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          if (attempt > 0) {
            const delay = Math.min(1000 * 2 ** (attempt - 1), 15000);
            await this.waitOrOnline(delay);
          }
          const resp = await fetch(mpdUrl, {
            signal: AbortSignal.timeout(Player.INIT_FETCH_TIMEOUT_MS),
          });
          if (!resp.ok) throw new Error(`MPD fetch HTTP ${resp.status}`);
          mpdText = await resp.text();
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e as Error;
          console.warn(`[PLAYER] MPD fetch attempt ${attempt + 1} failed: ${(e as Error).message}`);
        }
      }
      if (lastErr) throw lastErr;
    }

    this._baseUrl = mpdUrl.substring(0, mpdUrl.lastIndexOf("/") + 1);
    plog(`[PLAYER] baseUrl: ${this._baseUrl}`);

    this.tracks = this.parseMPD(mpdText!, this._baseUrl);
    if (this._destroyed) return;
    if (this.tracks.length === 0) {
      console.error("[PLAYER] No playable tracks");
      return;
    }

    const ms = new MS!() as MediaSource;
    this.ms = ms;
    ms.addEventListener("sourceopen", () => plog("[PLAYER] MediaSource: sourceopen"));
    ms.addEventListener("sourceended", () => plog("[PLAYER] MediaSource: sourceended"));
    ms.addEventListener("sourceclose", () => plog("[PLAYER] MediaSource: sourceclose"));

    this._reinitInProgress = true;
    try {
      this._attachMediaSource(ms);

      if (this._video && ms.readyState === "open") {
        await this._startPlayback(resumeTime);
      } else {
        await new Promise<void>((resolve, reject) => {
          ms.addEventListener(
            "sourceopen",
            () => {
              this._startPlayback(resumeTime).then(resolve).catch(reject);
            },
            { once: true },
          );
        });
      }
    } finally {
      this._reinitInProgress = false;
    }
  }

  async _startPlayback(
    resumeTime: number | null,
    autoPlay: boolean = true,
    playbackState?: { playbackRate: number; defaultPlaybackRate: number },
  ): Promise<void> {
    if (this.started || this._destroyed) return;
    this.started = true;
    this._endOfStreamCalled = false;
    plog(`[PLAYER] _startPlayback resumeTime=${resumeTime ?? "null"}`);

    for (const track of this.tracks) {
      let sb: SourceBuffer;
      try {
        sb = this.ms!.addSourceBuffer(track.mime);
      } catch (e) {
        if (isAnonymousNetworkPage()) {
          this._emitCompatibilityWarning("anonymous-codec");
        }
        throw e;
      }
      track.sb = sb;
      track.sbToken++;
      sb.mode = "segments";
      plog(`[${track.type.toUpperCase()}] SourceBuffer created: ${track.mime}`);
      sb.addEventListener("error", (e) => console.error(`[${track.type.toUpperCase()}] SourceBuffer error`, e));
      sb.addEventListener("abort", () => console.warn(`[${track.type.toUpperCase()}] SourceBuffer abort`));
      sb.addEventListener("updateend", () => {
        let buf = "";
        try {
          for (let i = 0; i < sb.buffered.length; i++)
            buf += `[${sb.buffered.start(i).toFixed(3)}-${sb.buffered.end(i).toFixed(3)}]`;
        } catch (e) {
          console.error(`[${track.type.toUpperCase()}] buffered read:`, e);
        }
        plog(`[${track.type.toUpperCase()}] updateend buffered=${buf || "(empty)"}`);
      });
    }

    await Promise.all(this.tracks.map((track) => this._appendInit(track)));

    if (this._video && playbackState) {
      try {
        this._video.defaultPlaybackRate = playbackState.defaultPlaybackRate;
        this._video.playbackRate = playbackState.playbackRate;
      } catch (e) {
        console.error("[PLAYER] playbackRate restore failed:", e);
      }
    }

    if (resumeTime != null && resumeTime > 0.5) {
      this._setPendingResumeTime(resumeTime);
      this.lastSeekTime = resumeTime;
      this._rememberExplicitTarget(resumeTime);
    }

    this._startFetchLoopsInner();

    if (resumeTime != null && resumeTime > 0.5) {
      void this._resumeWhenBuffered(resumeTime, autoPlay);
    } else if (autoPlay) {
      this._play();
    }

    plog("[PLAYER] Init complete");
  }

  _startFetchLoopsInner(): void {
    if (this._destroyed) return;
    const gen = this.generation;
    plog(`[PLAYER] _startFetchLoopsInner gen=${gen}`);
    for (const track of this.tracks) {
      this._cancelTrackPrune(track);
      track.inflight.clear();
      this._pruneAppended(track);
    }
    for (const track of this.tracks) {
      this._fetchLoop(track, gen);
    }
  }

  async _resumeWhenBuffered(resumeTime: number, autoPlay: boolean = true): Promise<void> {
    if (this._destroyed) return;

    const requestedTime = Math.max(0, resumeTime);
    const generation = this.generation;
    const mediaSource = this.ms;
    const audioTrack = this.tracks.find((t) => t.type === "audio") ?? null;
    const finishResume = () => {
      if (generation === this.generation && mediaSource === this.ms) {
        this._resumeInProgress = false;
      }
    };
    this._resumeInProgress = true;

    try {
      const duration = this._video?.duration ?? (this.ms && Number.isFinite(this.ms.duration) ? this.ms.duration : NaN);

      // 경계 직전에서 바로 재생하면 다시 stall 나므로,
      // 요청 시점보다 조금 앞(250ms)까지 버퍼가 찼는지 확인한다.
      const readyThrough = Number.isFinite(duration)
        ? Math.min(requestedTime + 0.25, Math.max(requestedTime, duration - 0.01))
        : requestedTime + 0.25;

      // No time-based deadline: wait as long as the network and decoder need.
      // Exit conditions are reinit (generation change), MediaSource swap, or destroy —
      // never "we waited too long, just play from wherever". Playing from 0 corrupts
      // saved progress and confuses the user; better to remain paused until ready.
      while (true) {
        if (generation !== this.generation || mediaSource !== this.ms || this._destroyed) {
          return;
        }

        const videoSb = this._getVideoSb();
        const videoEnd = videoSb ? this.getBufferedEnd(videoSb, requestedTime) : -Infinity;
        const audioEnd = audioTrack ? this._bufferedEndForTrack(audioTrack, requestedTime) : Number.POSITIVE_INFINITY;

        const videoReady = !!videoSb && videoEnd >= readyThrough - 0.01;
        const audioReady = !audioTrack || audioEnd >= readyThrough - 0.01;

        if (videoReady && audioReady) break;
        await this.wait(50);
      }

      if (generation !== this.generation || mediaSource !== this.ms || this._destroyed) {
        return;
      }

      plog(`[PLAYER] Resuming at ${requestedTime.toFixed(3)}s`);
      this._setPendingResumeTime(requestedTime);
      this._internalSeek = true;
      this._seekTo(requestedTime);

      if (autoPlay) this._play();
    } finally {
      finishResume();
    }
  }

  _pruneAppended(track: Track): void {
    if (!track.sb || !track.timeline) return;
    for (const segNum of [...track.appended]) {
      const range = this.segmentNumberToTimeRange(track, segNum);
      if (!range) {
        track.appended.delete(segNum);
        continue;
      }
      const mid = (range.start + range.end) / 2;
      let inBuffer = false;
      try {
        for (let i = 0; i < track.sb.buffered.length; i++) {
          if (track.sb.buffered.start(i) <= mid + 0.1 && track.sb.buffered.end(i) >= mid - 0.1) {
            inBuffer = true;
            break;
          }
        }
      } catch (e) {
        console.error(`[${track.type.toUpperCase()}] appended sync:`, e);
      }
      if (!inBuffer) track.appended.delete(segNum);
    }
  }

  _checkEndOfStream(): void {
    if (!this.ms || this.ms.readyState !== "open") return;
    if (this._endOfStreamCalled) return;

    for (const track of this.tracks) {
      if (!track.timeline) return;
      const lastSeg = track.startNumber + track.timeline.length - 1;
      if (!track.appended.has(lastSeg)) return;
    }

    // Wait until playback is actually near the end to avoid "End of file" decode errors
    const ct = this._currentTime;
    const dur = this.ms.duration;
    if (isFinite(dur) && dur > 0 && dur - ct > Player.AUTO_TIME_EPSILON) {
      return;
    }

    this._endOfStreamCalled = true;
    try {
      plog("[PLAYER] All segments appended, calling endOfStream()");
      this.ms.endOfStream();
    } catch (e) {
      console.error("[PLAYER] endOfStream() failed:", e);
    }
  }

  _getVideoTrackForResume(): Track | null {
    return (
      this.tracks.find((t) => t.type === "video") ??
      this.videoReps.find((t) => t.repId === this.activeVideoRepId) ??
      this.videoReps[0] ??
      null
    );
  }

  _getResumeAnchorTime(time: number): number {
    const track = this._getVideoTrackForResume();
    if (!track?.timeline?.length) return Math.max(0, time);
    const segNum = this.timeToSegmentNumber(track, time);
    const range = this.segmentNumberToTimeRange(track, segNum);
    if (!range) return Math.max(0, time);
    const anchor = Math.max(0, range.start + 0.01);
    if (Math.abs(anchor - time) >= 0.25) {
      plog(`[PLAYER] resume anchor ${time.toFixed(3)}s -> seg ${segNum} start ${anchor.toFixed(3)}s`);
    }
    return anchor;
  }

  _getSeekFetchTime(track: Track, time: number): number {
    if (track.type !== "video" || !track.timeline?.length) {
      return time;
    }
    if (this._video?.ended) return time;
    const segNum = this.timeToSegmentNumber(track, time);
    if (segNum <= track.startNumber) {
      return time;
    }
    const prevRange = this.segmentNumberToTimeRange(track, segNum - 1);
    if (!prevRange) return time;
    const fetchTime = Math.max(0, prevRange.start + 0.01);
    plog(
      `[PLAYER] seek fetch preroll ${time.toFixed(3)}s -> seg ${segNum - 1} @ ${fetchTime.toFixed(3)}s`,
    );
    return fetchTime;
  }

  _getSeekPlaybackTime(time: number): number {
    return time;
  }

  _getDecodeRecoveryTime(time: number): number {
    const safe = Math.max(0, time + Player.AUTO_TIME_EPSILON);
    console.warn(`[PLAYER] decode recovery ${time.toFixed(3)}s -> ${safe.toFixed(3)}s`);
    return safe;
  }

  _stopFetchLoops(reason: string): void {
    this.generation++;
    for (const ac of this.abortControllers) ac.abort();
    this.abortControllers.clear();
    for (const track of this.tracks) {
      this._cancelTrackPrune(track);
      for (const [, ac] of track.inflightAcs) ac.abort();
      track.inflightAcs.clear();
      track.inflight.clear();
    }
    console.warn(`[PLAYER] fetch loops stopped: ${reason}`);
  }

  async _fetchLoop(track: Track, generation: number): Promise<void> {
    if (this._destroyed) return;
    const ac = new AbortController();
    this.abortControllers.add(ac);
    plog(`[${track.type.toUpperCase()}] fetchLoop start gen=${generation}`);

    try {
      let pollCount = 0;
      while (generation === this.generation && !this._destroyed) {
        if (!track.sb) return;
        if (this._video?.error) {
          console.warn(`[${track.type.toUpperCase()}] fetchLoop stopped: media element is in error state`);
          return;
        }
        const ct = this._currentTime;
        const bufferedEnd = this._bufferedEndForTrack(track, ct);
        const ahead = bufferedEnd - ct;

        if (pollCount % 25 === 0) {
          plog(
            `[${track.type.toUpperCase()}] poll ct=${ct.toFixed(3)} ahead=${ahead.toFixed(3)}` +
              ` rs=${this._readyState} ${this._videoWidth}x${this._videoHeight}`,
          );
        }
        pollCount++;

        if (ahead >= this.BUFFER_AHEAD_MAX) {
          const keepStart = Math.max(0, ct - this.BUFFER_BEHIND_KEEP);
          try {
            const sb = this._getLiveTrackSb(track);
            if (sb && sb.buffered.length > 0 && sb.buffered.start(0) < keepStart - 1) {
              const token = track.sbToken;
              this._schedulePruneTrackBehind(track, token, keepStart);
            }
          } catch (e) {
            console.error(`[${track.type.toUpperCase()}] buffer prune scheduling failed:`, e);
          }
          await this.wait(this.POLL_INTERVAL);
          continue;
        }

        let fetchFromTime: number;
        if (this.seekInProgress || Math.abs(ct - this.lastSeekTime) < 0.5) {
          fetchFromTime = this._getSeekFetchTime(track, ct);
        } else {
          fetchFromTime = ahead > 0.5 ? bufferedEnd : ct;
        }

        let segNum = this.timeToSegmentNumber(track, fetchFromTime);
        let skipCount = 0;
        while ((track.appended.has(segNum) || track.inflight.has(segNum)) && skipCount < track.timeline!.length) {
          segNum++;
          skipCount++;
        }

        if (skipCount >= track.timeline!.length) {
          await this.wait(this.POLL_INTERVAL);
          continue;
        }

        const range = this.segmentNumberToTimeRange(track, segNum);
        if (!range) {
          await this.wait(this.POLL_INTERVAL);
          continue;
        }

        if (range.start - ct >= this.BUFFER_AHEAD_MAX) {
          await this.wait(this.POLL_INTERVAL);
          continue;
        }

        // Auto-skip: don't buffer deep into OP/ED ranges.
        // Allow at most 1 segment past skipStart so decode stays smooth until
        // the skip fires, then stop; the post-skip buffer fills after the seek.
        const skipOptActive =
          this.skipRanges.length > 0 &&
          (typeof localStorage === "undefined" || localStorage.getItem("player_autoskip") !== "off");
        if (skipOptActive && isInSkipInterior(this.skipRanges, ct, range.start, range.duration)) {
          await this.wait(this.POLL_INTERVAL);
          continue;
        }

        await this._fetchAndAppend(track, segNum, ac.signal, generation);

        this._checkEndOfStream();
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error(`[${track.type.toUpperCase()}] fetchLoop error:`, e);
      } else {
        plog(`[${track.type.toUpperCase()}] fetchLoop aborted`);
      }
    } finally {
      this.abortControllers.delete(ac);
    }
  }

  async _fetchAndAppend(track: Track, segNum: number, signal: AbortSignal, generation: number): Promise<void> {
    if (this._destroyed) return;
    if (track.inflight.has(segNum) || track.appended.has(segNum)) return;
    track.inflight.add(segNum);
    const segAc = new AbortController();
    track.inflightAcs.set(segNum, segAc);
    if (signal.aborted) segAc.abort(signal.reason);
    const fetchSignal = segAc.signal;
    try {
    const MAX_RETRIES = 6;
    const BASE_DELAY_MS = 1000;

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (generation !== this.generation || this._destroyed) {
        track.inflight.delete(segNum);
        return;
      }
      if (this._video?.error) {
        console.warn(
          `[${track.type.toUpperCase()}] media element is in error state; stopping retries for seg ${segNum}`,
        );
        track.inflight.delete(segNum);
        return;
      }

      try {
        if (attempt > 0) {
          const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 30000);
          console.warn(`[${track.type.toUpperCase()}] seg ${segNum} retry ${attempt}/${MAX_RETRIES} in ${delay}ms`);
          await this.waitOrOnline(delay);
          if (generation !== this.generation || this._destroyed) {
            track.inflight.delete(segNum);
            return;
          }
          if (this._video?.error) {
            console.warn(
              `[${track.type.toUpperCase()}] media element entered error state during retry; stopping seg ${segNum}`,
            );
            track.inflight.delete(segNum);
            return;
          }
        }

        const url = track.mediaPattern.replace("$Number$", String(segNum));
        if (attempt === 0) plog(`[${track.type.toUpperCase()}] fetch seg ${segNum}: ${url}`);

        const resp = await fetch(url, {
          signal: this._timedSignal(fetchSignal, Player.SEG_FETCH_TIMEOUT_MS),
        });
        plog(`[${track.type.toUpperCase()}] seg ${segNum} status=${resp.status}`);

        if (!resp.ok) {
          if (resp.status === 404 || resp.status === 410) {
            track.appended.add(segNum);
            track.inflight.delete(segNum);
            return;
          }
          throw new Error(`HTTP ${resp.status}`);
        }

        let data: Uint8Array<ArrayBufferLike> = new Uint8Array(await resp.arrayBuffer());
        data = await this.decryptSegment(data, track.type);

        if (generation !== this.generation || this._destroyed || !track.sb) {
          track.inflight.delete(segNum);
          return;
        }

        const token = track.sbToken;
        const appended = await this._appendToTrack(track, token, data);
        if (!appended) {
          track.inflight.delete(segNum);
          return;
        }
        track.appended.add(segNum);

        const range = this.segmentNumberToTimeRange(track, segNum);
        plog(
          `[${track.type.toUpperCase()}] Seg ${segNum} appended (${range!.start.toFixed(3)}-${range!.end.toFixed(3)}s)` +
            ` rs=${this._readyState}`,
        );
        track.inflight.delete(segNum);
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          track.inflight.delete(segNum);
          throw e;
        }
        lastErr = e as Error;
        const msg = (e as Error).message || "";
        console.warn(`[${track.type.toUpperCase()}] seg ${segNum} attempt ${attempt} error: ${msg}`);
        if (
          msg.includes("no longer usable") ||
          msg.includes("no longer, usable") ||
          msg.includes("no longer") ||
          msg.includes("This SourceBuffer has been removed") ||
          msg.includes("InvalidStateError") ||
          msg.includes("HTMLMediaElement.error attribute is not null")
        ) {
          console.warn(`[${track.type.toUpperCase()}] SourceBuffer unusable; stopping retries for seg ${segNum}`);
          track.inflight.delete(segNum);
          return;
        }
        if (attempt === MAX_RETRIES) {
          console.error(`[${track.type.toUpperCase()}] seg ${segNum} permanently failed after ${MAX_RETRIES} retries`);
          track.appended.add(segNum);
        }
      }
    }

    void lastErr;
    track.inflight.delete(segNum);
    } finally {
      if (track.inflightAcs.get(segNum) === segAc) track.inflightAcs.delete(segNum);
    }
  }

  _handleSeeking(seekTime: number): void {
    if (this._destroyed) return;
    if (this._video?.error) {
      console.warn(`[PLAYER] seeking while media element is in error state; reinitializing to ${seekTime.toFixed(3)}s`);
      this.lastSeekTime = seekTime;
      this._setPendingResumeTime(seekTime);
      if (!this._recovering && !this._reinitInProgress) {
        this._reinitMediaSource(seekTime).catch((e) => console.error("[PLAYER] error-state seek reinit failed:", e));
      }
      return;
    }
    if (this._recovering || this._reinitInProgress) {
      this.lastSeekTime = seekTime;
      this._setPendingResumeTime(seekTime);
      this._queuedSeekTime = seekTime;
      plog(`[PLAYER] seeking queued during recovery → ${seekTime.toFixed(3)}s`);
      return;
    }
    if (this._video?.ended) {
      plog(`[PLAYER] seeking ignored (video ended) at ${seekTime.toFixed(3)}s`);
      return;
    }
    if (this._internalSeek) {
      this._internalSeek = false;
      plog(`[PLAYER] internal seek to ${seekTime.toFixed(3)}s, ignoring`);
      return;
    }

    if (seekTime < 0.5 && this._expectBrowserResetUntil && Date.now() < this._expectBrowserResetUntil) {
      this._expectBrowserResetUntil = 0;
      plog(`[PLAYER] seek to ${seekTime.toFixed(3)}s ignored (browser reset on src attach)`);
      return;
    }

    const normalizedSeekTime = this._getSeekPlaybackTime(seekTime);
    if (normalizedSeekTime !== seekTime && this._video) {
      this._internalSeek = true;
      this._seekTo(normalizedSeekTime);
      seekTime = normalizedSeekTime;
    }

    plog(`[PLAYER] seeking → ${seekTime.toFixed(3)}s`);
    this.lastSeekTime = seekTime;
    this._rememberExplicitTarget(seekTime);
    this._ct = seekTime;
    this._clearPendingResumeTime();
    this.seekInProgress = true;
    this._clearStallWatchdog();

    this.generation++;
    for (const ac of this.abortControllers) ac.abort();
    this.abortControllers.clear();
    // seek에서는 기존 MediaSource / SourceBuffer를 그대로 쓴다.
    // 이전 generation의 append 결과만 무시되도록 token만 올린다.
    for (const track of this.tracks) {
      this._cancelTrackPrune(track);
      for (const [, ac] of track.inflightAcs) ac.abort();
      track.inflightAcs.clear();
      track.inflight.clear();
      this._bumpTrackSbToken(track);
    }

    clearTimeout(this._seekTimeout!);
    const seekGeneration = this.generation;
    this._seekTimeout = setTimeout(async () => {
      if (this._destroyed || seekGeneration !== this.generation) return;
      this.seekInProgress = false;
      this._seekSettledAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      this._ct = this.lastSeekTime;

      const settled = this._video ? this._video.currentTime : this.lastSeekTime;
      if (Math.abs(settled - this.lastSeekTime) >= 2.0) {
        console.warn(
          `[PLAYER] seek settle mismatch (ct=${settled.toFixed(2)} vs target=${this.lastSeekTime.toFixed(2)}), aborting seek handling`,
        );
        return;
      }
      plog(`[PLAYER] seek settled at ${settled.toFixed(3)}s`);

      for (const track of this.tracks) {
        if (this._destroyed || seekGeneration !== this.generation) return;
        try {
          const token = track.sbToken;
          const sb = this._getLiveTrackSb(track, token);
          if (!sb) continue;
          await this.waitForIdle(sb);
          if (this._destroyed || seekGeneration !== this.generation) return;
          if (!this._getLiveTrackSb(track, token)) continue;
          const seekInBuffer = this._trackTimeInBuffer(track, settled);
          if (seekInBuffer) {
            const keepStart = Math.max(0, settled - this.BUFFER_BEHIND_KEEP);
            const keepEnd = settled + this.BUFFER_AHEAD_MAX;
            await this._trimTrackBuffer(track, token, keepStart, keepEnd);
            plog(`[${track.type.toUpperCase()}] seek: buffer trimmed (in-buffer seek)`);
          } else {
            const liveSb = this._getLiveTrackSb(track, token);
            if (liveSb?.buffered.length) {
              await this._removeFromTrack(
                track,
                token,
                liveSb.buffered.start(0),
                liveSb.buffered.end(liveSb.buffered.length - 1),
              );
            }
            plog(`[${track.type.toUpperCase()}] seek: buffer cleared (out-of-buffer seek)`);
            try {
              await this._appendInit(track);
            } catch (e) {
              console.error(`[${track.type.toUpperCase()}] seek init append failed: ${(e as Error).message}`);
            }
          }
        } catch (e) {
          console.error(`[${track.type.toUpperCase()}] seek buffer op failed: ${(e as Error).message}`);
        }
      }

      this._startFetchLoopsInner();
      if (this._destroyed || seekGeneration !== this.generation) return;
      this._stallCheckCount = 0;
      this._stallSnapshotTime = null;
      this._stallSnapshotBuf = null;
      this._startStallWatchdog();
    }, this.seekDebounceMs);
  }

  _handleVideoError(code: number | undefined): void {
    if (this._destroyed) return;
    console.error(`[VIDEO] error code=${code} ct=${this._currentTime.toFixed(3)}`);
    if (code === 4 /* MEDIA_ERR_SRC_NOT_SUPPORTED */ && isAnonymousNetworkPage()) {
      this._stopFetchLoops("anonymous network codec unsupported");
      this._emitCompatibilityWarning("anonymous-codec");
      return;
    }
    if (code === 3 /* MEDIA_ERR_DECODE */ || code === 2 /* MEDIA_ERR_NETWORK */) {
      let ct = Math.max(0, this._safeCurrentTime());
      const now = Date.now();
      const duration = this._video?.duration ?? (this.ms && Number.isFinite(this.ms.duration) ? this.ms.duration : NaN);

      // Firefox는 tail decode EOF를 실제 종료보다 훨씬 이르게 올릴 수 있다.
      // 따라서 "끝 3초 이내"만으로 종료 처리하지 말고, 거의 실제 끝일 때만 finalize한다.
      if (Number.isFinite(duration) && duration > 0) {
        const remaining = duration - ct;
        const inFirefoxTailWindow = this._isFirefox && remaining <= Player.FIREFOX_TAIL_DECODE_EOF_SECONDS;
        const atActualEnd = remaining <= Player.AUTO_TIME_EPSILON;

        if (inFirefoxTailWindow && !atActualEnd) {
          const explicitTailIntent = this._hasExplicitTailResumeIntent(ct, duration);
          const backoff = explicitTailIntent ? 0.15 : 0.25;
          const recoveryTime = Math.max(0, Math.min(ct, duration - Player.AUTO_TIME_EPSILON) - backoff);
          console.warn(
            `[PLAYER] Firefox tail MediaError before actual end (ct=${ct.toFixed(3)} / dur=${duration.toFixed(3)}), reinitializing from ${recoveryTime.toFixed(3)}s`,
          );
          this._clearStallWatchdog();
          this._lastErrorTime = recoveryTime;
          this._stopFetchLoops(explicitTailIntent ? "tail-explicit-target media error" : "tail-firefox media error");
          this._reinitMediaSource(recoveryTime).catch((e) =>
            console.error("[PLAYER] Firefox tail recovery reinit failed:", e),
          );
          return;
        }

        if ((!this._isFirefox && atActualEnd) || (this._isFirefox && atActualEnd)) {
          console.warn(
            `[PLAYER] MediaError at actual end (ct=${ct.toFixed(3)} / dur=${duration.toFixed(3)}), finalizing playback`,
          );
          this._clearStallWatchdog();
          this._stopFetchLoops("near-end media error");
          try {
            if (this.ms && this.ms.readyState === "open") {
              this.ms.endOfStream();
            }
          } catch (e) {
            console.error("[PLAYER] endOfStream() during error finalize failed:", (e as Error).message);
          }
          if (this._video) {
            this._internalSeek = true;
            this._video.currentTime = Math.max(0, duration - 0.001);
          }
          return;
        }
      }

      // 같은 지점에서 매우 짧은 간격으로 다시 에러가 나면 재초기화 폭주만 막고,
      // 디코더가 이미 망가진 상태라면 nudge보다 watchdog에 복구를 맡긴다.
      if (
        this._lastReinitAt > 0 &&
        now - this._lastReinitAt < 1500 &&
        this._lastReinitTime !== null &&
        Math.abs(ct - this._lastReinitTime) < 1.0
      ) {
        this._stopFetchLoops("throttled media error");
        console.warn(`[PLAYER] throttling immediate reinit loop at ${ct.toFixed(3)}s`);
        this._scheduleStallCheck();
        return;
      }

      if (this._lastErrorTime !== undefined && Math.abs(ct - this._lastErrorTime) < 2) {
        this._errorStreak = (this._errorStreak || 0) + 1;
        if (this._errorStreak >= Player.DECODE_RECOVERY_MAX_RETRIES) {
          const nearEndFallback =
            Number.isFinite(duration) && duration > 0 && duration - ct <= Player.FIREFOX_TAIL_DECODE_EOF_SECONDS + 2;
          const fallbackTime = nearEndFallback ? 0 : Math.max(0, Math.min(this._lastKnownGoodTime ?? 0, ct - 1));
          this._errorStreak = 0;
          this._lastErrorTime = fallbackTime;
          console.error(
            `[PLAYER] repeated decode/network error near ${ct.toFixed(3)}s; reinitializing from ${fallbackTime.toFixed(3)}s`,
          );
          this._reinitMediaSource(fallbackTime).catch((e) =>
            console.error("[PLAYER] repeated-error fallback reinit failed:", e),
          );
          return;
        }
      } else {
        this._errorStreak = 0;
      }
      if (code === 3 /* MEDIA_ERR_DECODE */) {
        ct = this._getDecodeRecoveryTime(ct);
      }
      this._lastErrorTime = ct;
      if (this._isFirefox && (code === 3 || this._errorStreak > 0)) {
        this._emitCompatibilityWarning("decode");
      }
      console.warn(`[PLAYER] MediaError, reinitializing from ${ct.toFixed(3)}s`);
      this._reinitMediaSource(ct).catch((e) => console.error("[PLAYER] Reinitialization failed:", e));
    }
  }

  stripDrmSignaling(initBuffer: Uint8Array, trackType: string): Uint8Array {
    return stripPlayerDrmSignaling(initBuffer, trackType);
  }

  async decryptSegment(data: Uint8Array, trackType?: string): Promise<Uint8Array<ArrayBufferLike>> {
    return decryptPlayerSegment(data, this.key, trackType);
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._clearStallWatchdog();
    if (this._seekTimeout !== null) {
      clearTimeout(this._seekTimeout);
      this._seekTimeout = null;
    }
    this.generation++;
    for (const ac of this.abortControllers) ac.abort();
    this.abortControllers.clear();
    for (const track of this.tracks) {
      for (const [, ac] of track.inflightAcs) ac.abort();
      track.inflightAcs.clear();
    }
    this._eventAc?.abort();
    this._eventAc = null;
    if (this._onOnline) {
      self.removeEventListener("online", this._onOnline);
      this._onOnline = null;
    }
    for (const track of this.tracks) {
      this._cancelTrackPrune(track);
      track.inflight.clear();
      track.appended.clear();
      this._invalidateTrackSb(track);
    }
    this.started = false;
    this.seekInProgress = false;
    this._clearPendingResumeTime();
    this._resumeInProgress = false;
    this._queuedSeekTime = null;
    this._recovering = false;
    this._reinitInProgress = false;
    if (this._objectUrl) {
      try {
        URL.revokeObjectURL(this._objectUrl);
      } catch (e) {
        console.error("[PLAYER] revokeObjectURL during destroy failed:", e);
      }
      this._objectUrl = null;
    }
    if (this._video) {
      try {
        this._video.pause();
      } catch (e) {
        console.error("[PLAYER] pause during destroy failed:", e);
      }
      try {
        this._video.removeAttribute("src");
        this._video.srcObject = null;
        this._video.load();
      } catch (e) {
        console.error("[PLAYER] clearing media during destroy failed:", e);
      }
    }
  }
}

export { Player };

const IS_WORKER = typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;

if (IS_WORKER) {
  if (MS === undefined) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({
      type: "error",
      message: "이 기기에서는 재생이 지원되지 않습니다.",
    });
  } else {
    let player: Player | null = null;

    self.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const data = e.data;
      switch (data.type) {
        case "init":
          player = new Player();
          player._qualityPref = parseInt((data.qualityPref as string) || "0", 10);
          player._qualityPrefBps = parseInt((data.qualityPrefBps as string) || "0", 10);
          player.init(data.mpdUrl!, data.kid!, data.key!, data.resumeTime ?? null).catch((err: Error) => {
            console.error("[PLAYER] Init failed:", err);
            (self as unknown as DedicatedWorkerGlobalScope).postMessage({
              type: "error",
              message: err.message || "재생을 시작할 수 없습니다.",
            });
          });
          break;

        case "timeupdate":
          if (player) {
            const now = typeof performance !== "undefined" ? performance.now() : Date.now();
            if (
              player._seekSettledAt !== undefined &&
              now - player._seekSettledAt < 5000 &&
              player.lastSeekTime >= 0 &&
              Math.abs((data.currentTime ?? 0) - player.lastSeekTime) > 2.0
            ) {
              break;
            }
            const prevRs = player._rs;
            player._ct = data.currentTime ?? 0;
            player._ctUpdatedAt = now;
            player._rs = data.readyState ?? 0;
            player._vw = data.videoWidth ?? 0;
            player._vh = data.videoHeight ?? 0;
            player._recordGoodTime(data.currentTime ?? 0);
            if ((data.readyState ?? 0) >= 3 && prevRs < 3) {
              player._stallCheckCount = 0;
            }
          }
          break;

        case "playing":
          if (player) {
            player._autoplayBlocked = false;
            player._stallCheckCount = 0;
            player._stallSnapshotTime = player._ct;
          }
          break;

        case "seeking":
          if (player) player._handleSeeking(data.currentTime ?? 0);
          break;

        case "videoError":
          if (player) player._handleVideoError(data.code);
          break;

        case "setQuality":
          if (player) player._switchVideoRep(data.repId!);
          break;

        case "dlDecryptSeg":
          if (player) {
            player
              .decryptSegment(new Uint8Array(data.buffer!))
              .then((r) =>
                (self as unknown as DedicatedWorkerGlobalScope).postMessage(
                  { type: "dlDecryptedSeg", id: data.id, buffer: r.buffer },
                  [r.buffer as ArrayBuffer],
                ),
              )
              .catch((e: Error) => {
                console.error("[PLAYER] download segment decrypt failed; returning original segment:", e);
                (self as unknown as DedicatedWorkerGlobalScope).postMessage({
                  type: "dlDecryptedSeg",
                  id: data.id,
                  buffer: data.buffer,
                });
              });
          }
          break;

        case "dlStripInit":
          if (player) {
            const stripped = player.stripDrmSignaling(new Uint8Array(data.buffer!), data.trackType!);
            (self as unknown as DedicatedWorkerGlobalScope).postMessage(
              { type: "dlStrippedInit", id: data.id, buffer: stripped.buffer },
              [stripped.buffer as ArrayBuffer],
            );
          }
          break;

        case "dlGetTracks":
          if (player) {
            const ser = (t: Track) => ({
              type: t.type,
              repId: t.repId,
              mime: t.mime,
              initUrl: t.initUrl,
              mediaPattern: t.mediaPattern,
              startNumber: t.startNumber,
              timescale: t.timescale,
              presentationTimeOffset: t.presentationTimeOffset,
              timeline: t.timeline,
              bandwidth: t.bandwidth,
              width: t.width,
              height: t.height,
            });
            (self as unknown as DedicatedWorkerGlobalScope).postMessage({
              type: "dlTracksReady",
              id: data.id,
              tracks: player.tracks.map(ser),
              videoReps: player.videoReps.map(ser),
            });
          }
          break;
      }
    };
  }
}
