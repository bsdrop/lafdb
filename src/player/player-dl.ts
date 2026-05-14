import {
  buildMuxedInitSegment,
  concatUint8Arrays,
  keepOnlyTopLevelBoxes,
  rewriteAudioTfhdTrackId,
  shiftTfdtBaseTime,
} from "./mp4-box";

  declare global {  interface Window {
    _dlInit: (mpdUrl: string, playerOrWorker: unknown, isWorker: boolean) => void;
    _dlHandleMsg: (data: Record<string, unknown>) => void;
    _dlDurSecs?: number;
  }
}

interface DlTrack {
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
}

interface DlPlayerRef {
  tracks: DlTrack[];
  videoReps: DlTrack[];
  stripDrmSignaling(buf: Uint8Array, trackType: string): Uint8Array;
  decryptSegment(buf: Uint8Array): Promise<Uint8Array>;
}

const Mp4Mux = (() => {
  function keepMoofMdat(seg: Uint8Array): Uint8Array {
    return keepOnlyTopLevelBoxes(seg, new Set(["moof", "mdat"]));
  }

  function assemble(
    vInit: Uint8Array,
    aInit: Uint8Array,
    vSegs: Uint8Array[],
    aSegs: Uint8Array[],
    durSecs: number | null | undefined,
    vOffset: number,
    aOffset: number,
  ): Uint8Array {
    const parts: Uint8Array[]=[buildMuxedInitSegment(vInit,aInit,durSecs,2)];
    const n=Math.max(vSegs.length,aSegs.length);
    for(let i=0;i<n;i++){
      if(i<vSegs.length)parts.push(vOffset?shiftTfdtBaseTime(keepMoofMdat(vSegs[i]),-vOffset):keepMoofMdat(vSegs[i]));
      if(i<aSegs.length)parts.push(rewriteAudioTfhdTrackId(aOffset?shiftTfdtBaseTime(keepMoofMdat(aSegs[i]),-aOffset):keepMoofMdat(aSegs[i]),2));
    }
    return concatUint8Arrays(...parts);
  }
  return {assemble};
})();

let _dlMpdUrl: string | null = null;
let _dlWorker: Worker | null = null;
let _dlPlayerRef: DlPlayerRef | null = null;
window._dlDurSecs = undefined;
let _dlReqId = 0;
const _dlPending = new Map<number, (result: unknown) => void>();
let _dlAbort: AbortController | null = null;

function _dlInit(mpdUrl: string, workerOrPlayer: unknown, isWorker: boolean): void {
  _dlMpdUrl = mpdUrl;
  if (isWorker) { _dlWorker = workerOrPlayer as Worker; _dlPlayerRef = null; }
  else { _dlPlayerRef = workerOrPlayer as DlPlayerRef; _dlWorker = null; }
  const btn = document.getElementById('btn-download') as HTMLElement | null;
  if (btn) btn.hidden = !globalThis.crypto?.subtle;
}

function _dlHandleMsg(data: Record<string, unknown>): void {
  const cb = _dlPending.get(data['id'] as number);
  if (!cb) return;
  _dlPending.delete(data['id'] as number);
  if (data['type'] === 'dlDecryptedSeg' || data['type'] === 'dlStrippedInit')
    cb(new Uint8Array(data['buffer'] as ArrayBuffer));
  else if (data['type'] === 'dlTracksReady')
    cb({ tracks: data['tracks'], videoReps: data['videoReps'] });
}

async function _dlDecrypt(buf: Uint8Array, isInit: boolean, trackType: string): Promise<Uint8Array> {
  if (_dlWorker) {
    return new Promise(resolve => {
      const id = ++_dlReqId;
      _dlPending.set(id, resolve as (result: unknown) => void);
      const copy = buf.slice().buffer;
      _dlWorker!.postMessage({ type: isInit ? 'dlStripInit' : 'dlDecryptSeg', id, buffer: copy, trackType }, [copy]);
    });
  }
  if (_dlPlayerRef) {
    return isInit ? _dlPlayerRef.stripDrmSignaling(buf, trackType) : _dlPlayerRef.decryptSegment(buf);
  }
  return buf;
}

async function _dlGetTracks(repId: string): Promise<{ video: DlTrack | null; audio: DlTrack | null }> {
  let tracks: DlTrack[], videoReps: DlTrack[];
  if (_dlWorker) {
    const result = await new Promise<{ tracks: DlTrack[]; videoReps: DlTrack[] }>(resolve => {
      const id = ++_dlReqId;
      _dlPending.set(id, resolve as (result: unknown) => void);
      _dlWorker!.postMessage({ type: 'dlGetTracks', id });
    });
    tracks = result.tracks; videoReps = result.videoReps;
  } else {
    tracks = _dlPlayerRef!.tracks;
    videoReps = _dlPlayerRef!.videoReps;
  }
  const videoTrack = repId ? (videoReps.find(r => r.repId === repId) || videoReps[0]) : videoReps[0];
  const audioTrack = tracks.find(t => t.type === 'audio');
  return { video: videoTrack || null, audio: audioTrack || null };
}

interface ProgressInfo {
  phase: string;
  msg?: string;
  pct?: number;
  vDone?: number;
  vCount?: number;
  aDone?: number;
  aCount?: number;
  bytes?: number;
  speed?: number;
  eta?: number;
}

async function _dlRun(repId: string, onProgress: (p: ProgressInfo) => void): Promise<Uint8Array> {
  _dlAbort = new AbortController();
  const sig = _dlAbort.signal;
  const FETCH_RETRY_LIMIT = 6;

  function isRetriableFetchError(err: unknown): boolean {
    if ((err as Error | undefined)?.name === 'AbortError') return false;
    const msg = String((err as Error | undefined)?.message ?? err ?? '');
    return (
      /NS_ERROR_NET_PARTIAL_TRANSFER/i.test(msg) ||
      /Content-Length header of network response exceeds response Body/i.test(msg) ||
      /NetworkError when attempting to fetch resource/i.test(msg) ||
      /Failed to fetch/i.test(msg) ||
      /Load failed/i.test(msg) ||
      /body stream/i.test(msg) ||
      /terminated/i.test(msg)
    );
  }

  function fetchRetryDelay(attempt: number): number {
    return Math.min(8000, 500 * Math.pow(2, attempt));
  }

  function waitForRetry(ms: number): Promise<void> {
    if (sig.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        sig.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort(): void {
        window.clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      }
      sig.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function fetchBuf(url: string): Promise<Uint8Array> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= FETCH_RETRY_LIMIT; attempt++) {
      if (sig.aborted) throw new DOMException('aborted', 'AbortError');
      try {
        const r = await fetch(url, { signal: sig });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return new Uint8Array(await r.arrayBuffer());
      } catch (err) {
        lastError = err;
        if (sig.aborted || !isRetriableFetchError(err) || attempt >= FETCH_RETRY_LIMIT) {
          throw err;
        }
        const delay = fetchRetryDelay(attempt);
        console.warn(`[DL] partial/network transfer failed; retry ${attempt + 1}/${FETCH_RETRY_LIMIT} in ${delay}ms`, err);
        await waitForRetry(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  onProgress({ phase: 'init', msg: '트랙 정보 불러오는 중…', pct: 0 });
  const { video, audio } = await _dlGetTracks(repId);
  if (!video || !audio) throw new Error('트랙 정보를 읽을 수 없습니다');
  const vCount = video.timeline?.length || 0;
  const aCount = audio.timeline?.length || 0;
  if (!vCount) throw new Error('세그먼트 목록이 비어있습니다');

  if (window._dlDurSecs == null) {
    const epId = new URLSearchParams(location.hash.slice(1)).get('epId');
    if (epId) {
      try {
        const ep = await apiFetch<{ running_time?: string }>(`/api/episodes/v3/${epId}`).catch((e: Error) => {
          console.error("[PLAYER] running_time fetch failed:", e);
          return null;
        });
        if (ep?.running_time) {
          const p = ep.running_time.split(':');
          if (p.length === 3) window._dlDurSecs = +p[0]*3600 + +p[1]*60 + parseFloat(p[2]);
        }
      } catch (e) { console.error("[PLAYER] running_time parse failed:", e); }
    }
  }

  const lastV = video.timeline![vCount-1];
  const durSecs = window._dlDurSecs ?? (lastV.time + lastV.duration - (video.timeline![0]?.time ?? 0)) / video.timescale;

  const vOffset = video.presentationTimeOffset ?? 0;
  const aOffset = audio.presentationTimeOffset ?? 0;

  onProgress({ phase: 'init', msg: '초기화 세그먼트 다운로드 중…', pct: 0 });
  const [vInitRaw, aInitRaw] = await Promise.all([fetchBuf(video.initUrl), fetchBuf(audio.initUrl)]);
  const [vInit, aInit] = await Promise.all([
    _dlDecrypt(vInitRaw, true, 'video'),
    _dlDecrypt(aInitRaw, true, 'audio'),
  ]);

  const startTime = Date.now();
  let vDone = 0, aDone = 0;
  let totalBytes = 0;
  let videoBytes = 0;
  const speedSamples: Array<{ t: number; cum: number }> = [];
  const videoSpeedSamples: Array<{ t: number; cum: number }> = [];
  const SPEED_WIN_MS = 6000;
  let smoothEta = 0;
  const ETA_ALPHA = 0.15;

  function _addBytes(n: number, trackType: string): void {
    totalBytes += n;
    const now = Date.now();
    speedSamples.push({ t: now, cum: totalBytes });
    if (trackType === 'video') {
      videoBytes += n;
      videoSpeedSamples.push({ t: now, cum: videoBytes });
    }
    const cutoff = now - SPEED_WIN_MS;
    while (speedSamples.length > 2 && speedSamples[0].t < cutoff) speedSamples.shift();
    while (videoSpeedSamples.length > 2 && videoSpeedSamples[0].t < cutoff) videoSpeedSamples.shift();
  }

  function _windowSpeed(samples = speedSamples, bytes = totalBytes): number {
    if (samples.length < 2) {
      const el = Math.max((Date.now() - startTime) / 1000, 0.1);
      return bytes / el;
    }
    const a = samples[0], b = samples[samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt < 0.3) {
      const el = Math.max((Date.now() - startTime) / 1000, 0.1);
      return bytes / el;
    }
    return (b.cum - a.cum) / dt;
  }

  function emitProgress(): void {
    const done = vDone + aDone;
    const total = vCount + aCount;
    const pct = done / total * 100;
    const speed = _windowSpeed();
    const videoSpeed = _windowSpeed(videoSpeedSamples, videoBytes);
    const avgVideoSeg = vDone > 0 ? videoBytes / vDone : 0;
    const rawEta = videoSpeed > 1024 && vDone < vCount ? (vCount - vDone) * avgVideoSeg / videoSpeed : 0;
    if (rawEta > 0) smoothEta = smoothEta > 0 ? smoothEta + ETA_ALPHA * (rawEta - smoothEta) : rawEta;
    const eta = rawEta > 0 ? smoothEta * 1.1 : 0;
    onProgress({ phase: 'download', pct, vDone, vCount, aDone, aCount, bytes: totalBytes, speed, eta });
  }

  async function downloadTrack(
    track: DlTrack,
    count: number,
    trackType: string,
    onSeg: (bytes: number) => void,
  ): Promise<Uint8Array[]> {
    let nextFetch = 0;
    const results: Uint8Array[] = new Array(count);
    const CONC = 4;
    async function worker(): Promise<void> {
      while (true) {
        const i = nextFetch++;
        if (i >= count) return;
        if (sig.aborted) throw new DOMException('aborted', 'AbortError');
        const url = track.mediaPattern.replace('$Number$', String(track.startNumber + i));
        const raw = await fetchBuf(url);
        const dec = await _dlDecrypt(raw, false, trackType);
        results[i] = dec;
        onSeg(dec.byteLength);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    return results;
  }

  emitProgress();
  const [vSegs, aSegs] = await Promise.all([
    downloadTrack(video, vCount, 'video', (b) => { vDone++; _addBytes(b, 'video'); emitProgress(); }),
    downloadTrack(audio, aCount, 'audio', (b) => { aDone++; _addBytes(b, 'audio'); emitProgress(); }),
  ]);

  onProgress({ phase: 'mux', msg: 'MP4 생성 중…', pct: 99 });
  return Mp4Mux.assemble(vInit, aInit, vSegs, aSegs, durSecs, vOffset, aOffset);
}

(function () {
  const modal      = document.getElementById('dl-modal') as HTMLElement;
  const dlQualSel  = document.getElementById('dl-quality-sel') as HTMLSelectElement;
  const dlProgWrap = document.getElementById('dl-prog-wrap') as HTMLElement;
  const dlProgBar  = document.getElementById('dl-prog-bar') as HTMLElement;
  const dlProgText = document.getElementById('dl-prog-text') as HTMLElement;
  const dlProgStats= document.getElementById('dl-prog-stats') as HTMLElement;
  const dlBtnStart = document.getElementById('dl-btn-start') as HTMLButtonElement;

  function fillDlQual(playerSel: HTMLSelectElement): void {
    dlQualSel.innerHTML = '';
    for (const o of playerSel.options) {
      const el = document.createElement('option');
      el.value = o.value; el.textContent = o.textContent;
      if (o.selected) el.selected = true;
      dlQualSel.appendChild(el);
    }
    dlBtnStart.disabled = false;
  }
  const dlBtnCancel= document.getElementById('dl-btn-cancel') as HTMLButtonElement;
  const dlBtnBg    = document.getElementById('dl-btn-bg') as HTMLButtonElement;
  const toast      = document.getElementById('dl-toast') as HTMLElement;
  const toastBar   = document.getElementById('dl-toast-bar') as HTMLElement;
  const toastTitle = document.getElementById('dl-toast-title') as HTMLElement;
  const toastSub   = document.getElementById('dl-toast-sub') as HTMLElement;
  const toastOpen  = document.getElementById('dl-toast-open') as HTMLButtonElement;
  const toastAbort = document.getElementById('dl-toast-abort') as HTMLButtonElement;

  let _running = false;

  function fmtBytes(b: number): string {
    return b < 1048576 ? (b/1024).toFixed(0)+' KB' : (b/1048576).toFixed(1)+' MB';
  }
  function fmtSpeed(b: number): string {
    return b < 1048576 ? (b/1024).toFixed(0)+' KB/s' : (b/1048576).toFixed(1)+' MB/s';
  }
  function fmtEta(s: number): string {
    if (s <= 0 || !isFinite(s)) return '';
    const m = Math.floor(s/60), sec = Math.floor(s%60);
    return m > 0 ? m+'분 '+sec+'초' : sec+'초';
  }

  function applyProgress(p: ProgressInfo): void {
    if (!_running) return;
    if (p.phase === 'mux' || p.phase === 'init') {
      dlProgText.textContent = p.msg || '';
      dlProgStats.textContent = '';
      dlProgBar.style.width = (p.pct || 0) + '%';
      toastBar.style.width = (p.pct || 0) + '%';
      toastSub.textContent = p.msg || '';
      return;
    }
    const pct = (p.pct ?? 0).toFixed(1);
    dlProgBar.style.width = pct + '%';
    toastBar.style.width  = pct + '%';
    dlProgText.textContent = `비디오 ${p.vDone}/${p.vCount} · 오디오 ${p.aDone}/${p.aCount}`;
    const eta = fmtEta(p.eta ?? 0);
    const stats = `${fmtBytes(p.bytes ?? 0)} · ${fmtSpeed(p.speed ?? 0)}${eta ? ' · ETA '+eta : ''}`;
    dlProgStats.textContent = stats;
    toastSub.textContent = `${pct}% · ${stats}`;
  }

  document.getElementById('btn-download')!.addEventListener('click', () => {
    const playerSel = document.getElementById('quality-selector') as HTMLSelectElement;
    dlQualSel.innerHTML = '';
    if (!playerSel.options.length) {
      const el = document.createElement('option');
      el.value = ''; el.textContent = '화질 로딩 중…';
      dlQualSel.appendChild(el);
      dlBtnStart.disabled = true;
    } else {
      fillDlQual(playerSel);
    }
    dlProgWrap.hidden = true;
    dlProgBar.style.width = '0%';
    dlProgText.textContent = '';
    dlProgStats.textContent = '';
    dlBtnStart.textContent = '다운로드';
    dlBtnBg.hidden = true;
    dlBtnCancel.textContent = '취소';
    modal.hidden = false;
  });

  // quality-selector에 옵션이 추가될 때 모달이 "로딩 중" 상태면 자동으로 채움
  const playerSelObs = new MutationObserver(() => {
    const playerSel = document.getElementById('quality-selector') as HTMLSelectElement;
    if (!modal.hidden && dlBtnStart.disabled && playerSel.options.length) {
      fillDlQual(playerSel);
    }
  });
  const playerSelEl = document.getElementById('quality-selector');
  if (playerSelEl) playerSelObs.observe(playerSelEl, { childList: true });

  function hideModal(): void { modal.hidden = true; }
  dlBtnCancel.addEventListener('click', () => {
    if (_running) { if (_dlAbort) _dlAbort.abort(); _running = false; toast.hidden = true; }
    hideModal();
  });
  dlBtnBg.addEventListener('click', () => {
    hideModal();
    toast.hidden = false;
  });
  modal.addEventListener('click', e => {
    if (e.target === modal) {
      if (_running) { hideModal(); toast.hidden = false; }
      else dlBtnCancel.click();
    }
  });

  toastOpen.addEventListener('click', () => {
    toast.hidden = true;
    modal.hidden = false;
  });
  toastAbort.addEventListener('click', () => {
    if (_dlAbort) _dlAbort.abort();
    _running = false;
    toast.hidden = true;
  });

  dlBtnStart.addEventListener('click', async () => {
    if (_running) return;
    _running = true;
    dlBtnStart.disabled = true;
    dlBtnStart.textContent = '다운로드 중…';
    dlBtnBg.hidden = false;
    dlBtnCancel.textContent = '중단';
    dlProgWrap.hidden = false;
    const repId = dlQualSel.value;
    const epTitle = (document.getElementById('ep-title') as HTMLElement | null)?.textContent || 'episode';
    const filename = epTitle.replace(/[/\\?%*:|"<>]/g, '_') + '.mp4';
    toastTitle.textContent = epTitle;
    try {
      const mp4 = await _dlRun(repId, applyProgress);
      const url = URL.createObjectURL(new Blob([mp4 as Uint8Array<ArrayBuffer>], { type: 'video/mp4' }));
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      dlBtnStart.textContent = '완료 ✓';
      dlProgText.textContent = '다운로드가 시작되었습니다';
      dlProgStats.textContent = '';
      dlBtnBg.hidden = true;
      dlBtnCancel.textContent = '닫기';
      toast.hidden = true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') { toast.hidden = true; return; }
      console.error('[DL]', e);
      dlProgText.textContent = '오류: ' + (e as Error).message;
      dlProgStats.textContent = '';
      dlBtnStart.disabled = false;
      dlBtnStart.textContent = '다시 시도';
      dlBtnBg.hidden = true;
      dlBtnCancel.textContent = '취소';
      toast.hidden = true;
    } finally {
      _running = false;
    }
  });
})();

window._dlInit = _dlInit;
window._dlHandleMsg = _dlHandleMsg;

export {};
