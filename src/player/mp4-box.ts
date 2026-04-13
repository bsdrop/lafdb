export interface Mp4BoxInfo {
  type: string;
  start: number;
  headerSize: number;
  size: number;
  payload: Uint8Array;
}

export interface ParsedTfhd {
  flags: number;
  trackId: number;
  baseDataOffset?: number;
  sampleDescriptionIndex?: number;
  defaultSampleDuration?: number;
  defaultSampleSize?: number;
  defaultSampleFlags?: number;
}

export interface ParsedTrun {
  flags: number;
  sampleCount: number;
  dataOffset?: number;
  firstSampleFlags?: number;
}

export interface ParsedSencSubsample {
  clear: number;
  enc: number;
}

export interface ParsedSencSample {
  iv: Uint8Array;
  subsamples: ParsedSencSubsample[];
}

export interface ParsedSenc {
  flags: number;
  sampleCount: number;
  samples: ParsedSencSample[];
}

export interface ParsedTfdt {
  version: number;
  baseMediaDecodeTime: number;
}

export interface ParsedSidxReference {
  referenceType: boolean;
  referencedSize: number;
  segmentDuration: number;
  startsWithSap: boolean;
  sapType: number;
  sapDeltaTime: number;
}

export interface ParsedSidx {
  version: number;
  referenceId: number;
  timescale: number;
  earliestPresentationTime: number;
  firstOffset: number;
  references: ParsedSidxReference[];
}

const CONTAINER_BOXES: Record<string, 1> = {
  moov: 1,
  trak: 1,
  mdia: 1,
  minf: 1,
  stbl: 1,
  dinf: 1,
  udta: 1,
  edts: 1,
  mvex: 1,
};

const ZERO_ENTRY_STBL_BOXES: Record<string, 1> = {
  stts: 1,
  stsc: 1,
  stco: 1,
  co64: 1,
  stsz: 1,
};

export function readUint32(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) |
      (buf[offset + 1] << 16) |
      (buf[offset + 2] << 8) |
      buf[offset + 3]) >>>
    0
  );
}

export function writeUint32(
  buf: Uint8Array,
  offset: number,
  value: number,
): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

export function concatUint8Arrays(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function parseMp4Boxes(
  buf: Uint8Array,
  start: number = 0,
  end: number = buf.length,
): Mp4BoxInfo[] {
  const boxes: Mp4BoxInfo[] = [];
  let offset = start;

  while (offset + 8 <= end) {
    let size = readUint32(buf, offset);
    const type = String.fromCharCode(
      buf[offset + 4],
      buf[offset + 5],
      buf[offset + 6],
      buf[offset + 7],
    );
    let headerSize = 8;

    if (size === 1) {
      size =
        readUint32(buf, offset + 8) * 0x100000000 +
        readUint32(buf, offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) break;

    boxes.push({
      type,
      start: offset,
      headerSize,
      size,
      payload: buf.subarray(offset + headerSize, offset + size),
    });
    offset += size;
  }

  return boxes;
}

export function findMp4Box(
  buf: Uint8Array,
  type: string,
  start: number = 0,
  end: number = buf.length,
): Mp4BoxInfo | undefined {
  return parseMp4Boxes(buf, start, end).find((box) => box.type === type);
}

export function makeMp4Box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  writeUint32(out, 0, out.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(payload, 8);
  return out;
}

export function parseTfhd(payload: Uint8Array): ParsedTfhd {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const flags = view.getUint32(0) & 0x00ffffff;
  let offset = 4;
  const trackId = view.getUint32(offset);
  offset += 4;

  const parsed: ParsedTfhd = { flags, trackId };

  if (flags & 0x01) {
    parsed.baseDataOffset =
      view.getUint32(offset) * 0x100000000 + view.getUint32(offset + 4);
    offset += 8;
  }
  if (flags & 0x02) {
    parsed.sampleDescriptionIndex = view.getUint32(offset);
    offset += 4;
  }
  if (flags & 0x08) {
    parsed.defaultSampleDuration = view.getUint32(offset);
    offset += 4;
  }
  if (flags & 0x10) {
    parsed.defaultSampleSize = view.getUint32(offset);
    offset += 4;
  }
  if (flags & 0x20) {
    parsed.defaultSampleFlags = view.getUint32(offset);
  }

  return parsed;
}

export function parseTrun(payload: Uint8Array): ParsedTrun {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const flags = view.getUint32(0) & 0x00ffffff;
  let offset = 8;

  const parsed: ParsedTrun = {
    flags,
    sampleCount: view.getUint32(4),
  };

  if (flags & 0x01) {
    parsed.dataOffset = view.getInt32(offset);
    offset += 4;
  }
  if (flags & 0x04) {
    parsed.firstSampleFlags = view.getUint32(offset);
  }

  return parsed;
}

export function parseSenc(payload: Uint8Array): ParsedSenc {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const flags = view.getUint32(0) & 0x00ffffff;
  const sampleCount = view.getUint32(4);
  let offset = 8;
  const samples: ParsedSencSample[] = [];

  for (let i = 0; i < sampleCount; i++) {
    if (offset + 8 > payload.length) {
      throw new Error("senc iv exceeds payload");
    }
    const iv = payload.slice(offset, offset + 8);
    offset += 8;

    const subsamples: ParsedSencSubsample[] = [];
    if (flags & 0x02) {
      if (offset + 2 > payload.length) {
        throw new Error("senc subsample count exceeds payload");
      }
      const n = view.getUint16(offset);
      offset += 2;
      for (let j = 0; j < n; j++) {
        if (offset + 6 > payload.length) {
          throw new Error("senc subsample entry exceeds payload");
        }
        subsamples.push({
          clear: view.getUint16(offset),
          enc: view.getUint32(offset + 2),
        });
        offset += 6;
      }
    }

    samples.push({ iv, subsamples });
  }

  if (offset !== payload.length) {
    throw new Error("senc payload not fully consumed");
  }

  return { flags, sampleCount, samples };
}

export function parseTfdt(payload: Uint8Array): ParsedTfdt {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const version = view.getUint8(0);
  return {
    version,
    baseMediaDecodeTime:
      version === 1 ? Number(view.getBigUint64(4)) : view.getUint32(4),
  };
}

export function parseSidx(payload: Uint8Array): ParsedSidx {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const version = view.getUint8(0);
  const referenceId = view.getUint32(4);
  const timescale = view.getUint32(8);
  let offset = 12;
  let earliestPresentationTime = 0;
  let firstOffset = 0;

  if (version === 0) {
    earliestPresentationTime = view.getUint32(offset);
    firstOffset = view.getUint32(offset + 4);
    offset += 8;
  } else {
    earliestPresentationTime = Number(view.getBigUint64(offset));
    firstOffset = Number(view.getBigUint64(offset + 8));
    offset += 16;
  }

  offset += 2;
  const referenceCount = view.getUint16(offset);
  offset += 2;

  const references: ParsedSidxReference[] = [];
  for (let i = 0; i < referenceCount; i++) {
    const rawRef = view.getUint32(offset);
    const rawSap = view.getUint32(offset + 8);
    references.push({
      referenceType: !!(rawRef & 0x80000000),
      referencedSize: rawRef & 0x7fffffff,
      segmentDuration: view.getUint32(offset + 4),
      startsWithSap: !!(rawSap & 0x80000000),
      sapType: (rawSap >>> 28) & 0x7,
      sapDeltaTime: rawSap & 0x0fffffff,
    });
    offset += 12;
  }

  return {
    version,
    referenceId,
    timescale,
    earliestPresentationTime,
    firstOffset,
    references,
  };
}

export function replaceFullBoxTrackId(
  box: Uint8Array,
  trackId: number,
): Uint8Array {
  const out = box.slice();
  const type = String.fromCharCode(out[4], out[5], out[6], out[7]);
  if (type === "tkhd") {
    const offset = 8 + 4 + (out[8] === 1 ? 16 : 8);
    writeUint32(out, offset, trackId);
    return out;
  }
  if (type === "trex") {
    writeUint32(out, 12, trackId);
    return out;
  }
  return out;
}

function makeEmptyFullBox(type: string, version: number): Uint8Array {
  const isStsz = type === "stsz";
  const out = new Uint8Array(isStsz ? 20 : 16);
  writeUint32(out, 0, out.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out[8] = version;
  return out;
}

export function cleanMp4BoxTree(
  buf: Uint8Array,
  inStbl: boolean = false,
): Uint8Array {
  const type = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
  if (inStbl && ZERO_ENTRY_STBL_BOXES[type]) {
    const entryCount = type === "stsz" ? readUint32(buf, 16) : readUint32(buf, 12);
    if (entryCount === 0) return buf;
    return makeEmptyFullBox(type, buf[8]);
  }
  if (!CONTAINER_BOXES[type]) return buf;

  const nextInStbl = type === "stbl";
  const children = parseMp4Boxes(buf, 8, buf.length);
  let changed = false;
  const kept: Uint8Array[] = [];

  for (const child of children) {
    if (child.type === "free" || child.type === "skip") {
      changed = true;
      continue;
    }
    const next = cleanMp4BoxTree(
      buf.subarray(child.start, child.start + child.size),
      nextInStbl,
    );
    if (next.length !== child.size) changed = true;
    kept.push(next);
  }

  if (!changed) return buf;
  const body = concatUint8Arrays(...kept);
  const out = new Uint8Array(8 + body.length);
  writeUint32(out, 0, out.length);
  out.set(buf.subarray(4, 8), 4);
  out.set(body, 8);
  return out;
}

export function rewriteAudioTfhdTrackId(
  seg: Uint8Array,
  trackId: number,
): Uint8Array {
  const moof = findMp4Box(seg, "moof");
  if (!moof) return seg;
  const moofStart = moof.start;
  const moofEnd = moof.start + moof.size;
  const traf = findMp4Box(seg, "traf", moofStart + moof.headerSize, moofEnd);
  if (!traf) return seg;
  const trafStart = traf.start;
  const trafEnd = traf.start + traf.size;
  const tfhd = findMp4Box(seg, "tfhd", trafStart + traf.headerSize, trafEnd);
  if (!tfhd) return seg;

  const flags =
    (seg[tfhd.start + 9] << 16) |
    (seg[tfhd.start + 10] << 8) |
    seg[tfhd.start + 11];

  if (!(flags & 0x000001)) {
    const out = seg.slice();
    writeUint32(out, tfhd.start + 12, trackId);
    return out;
  }

  const newFlags = (flags & ~0x000001) | 0x020000;
  const oldTfhd = seg.subarray(tfhd.start, tfhd.start + tfhd.size);
  const newTfhd = new Uint8Array(tfhd.size - 8);
  writeUint32(newTfhd, 0, tfhd.size - 8);
  newTfhd.set(oldTfhd.subarray(4, 8), 4);
  newTfhd[8] = oldTfhd[8];
  newTfhd[9] = (newFlags >>> 16) & 0xff;
  newTfhd[10] = (newFlags >>> 8) & 0xff;
  newTfhd[11] = newFlags & 0xff;
  writeUint32(newTfhd, 12, trackId);
  newTfhd.set(oldTfhd.subarray(24), 16);

  const trafParts = parseMp4Boxes(seg, trafStart + traf.headerSize, trafEnd).map((box) =>
    box.type === "tfhd" ? newTfhd : seg.subarray(box.start, box.start + box.size),
  );
  const newTraf = makeMp4Box("traf", concatUint8Arrays(...trafParts));
  const moofParts = parseMp4Boxes(seg, moofStart + moof.headerSize, moofEnd).map((box) =>
    box.type === "traf" ? newTraf : seg.subarray(box.start, box.start + box.size),
  );
  return concatUint8Arrays(
    makeMp4Box("moof", concatUint8Arrays(...moofParts)),
    seg.subarray(moofEnd),
  );
}

export function keepOnlyTopLevelBoxes(
  seg: Uint8Array,
  keep: ReadonlySet<string>,
): Uint8Array {
  const boxes = parseMp4Boxes(seg, 0, seg.length);
  const kept = boxes.filter((box) => keep.has(box.type));
  if (kept.length === boxes.length) return seg;
  return concatUint8Arrays(
    ...kept.map((box) => seg.subarray(box.start, box.start + box.size)),
  );
}

function patchTrunDataOffsetBox(
  trunBox: Uint8Array,
  delta: number,
): Uint8Array {
  if (!delta) return trunBox;
  const out = trunBox.slice();
  const flags =
    ((out[9] << 16) | (out[10] << 8) | out[11]) >>> 0;
  if (!(flags & 0x01)) return out;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const current = view.getInt32(16);
  view.setInt32(16, current + delta);
  return out;
}

export function stripDrmAuxBoxesFromFragment(
  seg: Uint8Array,
  drmAuxTypes: ReadonlySet<string>,
): Uint8Array {
  const top = parseMp4Boxes(seg, 0, seg.length);
  const moof = top.find((box) => box.type === "moof");
  if (!moof) return seg;

  const moofChildren = parseMp4Boxes(seg, moof.start + moof.headerSize, moof.start + moof.size);
  let changed = false;
  const newMoofChildren: Uint8Array[] = [];

  for (const child of moofChildren) {
    if (child.type !== "traf") {
      newMoofChildren.push(seg.subarray(child.start, child.start + child.size));
      continue;
    }

    const trafChildren = parseMp4Boxes(
      seg,
      child.start + child.headerSize,
      child.start + child.size,
    );
    const kept: Uint8Array[] = [];
    let removedBytes = 0;

    for (const trafChild of trafChildren) {
      if (drmAuxTypes.has(trafChild.type)) {
        changed = true;
        removedBytes += trafChild.size;
        continue;
      }
      kept.push(seg.subarray(trafChild.start, trafChild.start + trafChild.size));
    }

    if (!removedBytes) {
      newMoofChildren.push(seg.subarray(child.start, child.start + child.size));
      continue;
    }

    const adjusted = kept.map((part) => {
      const type = String.fromCharCode(part[4], part[5], part[6], part[7]);
      return type === "trun" ? patchTrunDataOffsetBox(part, -removedBytes) : part;
    });
    newMoofChildren.push(makeMp4Box("traf", concatUint8Arrays(...adjusted)));
  }

  if (!changed) return seg;

  const newMoof = makeMp4Box("moof", concatUint8Arrays(...newMoofChildren));
  const rebuilt: Uint8Array[] = [];
  for (const box of top) {
    if (box.type === "moof") rebuilt.push(newMoof);
    else rebuilt.push(seg.subarray(box.start, box.start + box.size));
  }
  return concatUint8Arrays(...rebuilt);
}

export function shiftTfdtBaseTime(
  seg: Uint8Array,
  delta: number,
): Uint8Array {
  if (!delta) return seg;
  const moof = findMp4Box(seg, "moof", 0);
  if (!moof) return seg;
  const traf = findMp4Box(
    seg,
    "traf",
    moof.start + moof.headerSize,
    moof.start + moof.size,
  );
  if (!traf) return seg;
  const tfdt = findMp4Box(
    seg,
    "tfdt",
    traf.start + traf.headerSize,
    traf.start + traf.size,
  );
  if (!tfdt) return seg;
  const out = seg.slice();
  const offset = tfdt.start;
  const tfdtInfo = parseTfdt(
    out.subarray(tfdt.start + tfdt.headerSize, tfdt.start + tfdt.size),
  );
  if (tfdtInfo.version === 0) {
    writeUint32(
      out,
      offset + 12,
      Math.max(0, (tfdtInfo.baseMediaDecodeTime + delta) >>> 0),
    );
  } else {
    const nextTime = Math.max(0, tfdtInfo.baseMediaDecodeTime + delta);
    writeUint32(out, offset + 12, Math.floor(nextTime / 0x100000000) >>> 0);
    writeUint32(out, offset + 16, nextTime >>> 0);
  }
  return out;
}

function patchMvhdDuration(
  mvhd: Uint8Array,
  durationSeconds: number | null | undefined,
): { box: Uint8Array; timescale: number } {
  const out = mvhd.slice();
  const version = out[8];
  const timescale = readUint32(out, version === 0 ? 20 : 28);
  if (durationSeconds != null && timescale > 0) {
    writeUint32(
      out,
      version === 0 ? 24 : 32,
      Math.min(Math.round(durationSeconds * timescale), 0xffffffff),
    );
  }
  return { box: out, timescale };
}

function patchDurationFullBox(
  box: Uint8Array,
  durationSeconds: number | null | undefined,
  timescale: number,
  versionOffsets: { timescale: number; duration: number },
): Uint8Array {
  if (durationSeconds == null || timescale <= 0) return box;
  const out = box.slice();
  writeUint32(
    out,
    out[8] === 0 ? versionOffsets.duration : versionOffsets.duration + 8,
    Math.min(Math.round(durationSeconds * timescale), 0xffffffff),
  );
  return out;
}

function patchMdhdDuration(
  mdhd: Uint8Array,
  durationSeconds: number | null | undefined,
): Uint8Array {
  if (durationSeconds == null) return mdhd;
  const out = mdhd.slice();
  const version = out[8];
  const timescale = readUint32(out, version === 0 ? 20 : 28);
  writeUint32(
    out,
    version === 0 ? 24 : 32,
    Math.min(Math.round(durationSeconds * timescale), 0xffffffff),
  );
  return out;
}

function patchTrakDuration(
  trakBuf: Uint8Array,
  durationSeconds: number | null | undefined,
  movieTimescale: number,
): Uint8Array {
  const out = trakBuf.slice();
  const tkhd = findMp4Box(out, "tkhd", 8);
  if (tkhd) {
    out.set(
      patchDurationFullBox(
        out.subarray(tkhd.start, tkhd.start + tkhd.size),
        durationSeconds,
        movieTimescale,
        { timescale: 20, duration: 28 },
      ),
      tkhd.start,
    );
  }
  const mdia = findMp4Box(out, "mdia", 8);
  if (mdia) {
    const mdhd = findMp4Box(
      out,
      "mdhd",
      mdia.start + mdia.headerSize,
      mdia.start + mdia.size,
    );
    if (mdhd) {
      out.set(
        patchMdhdDuration(
          out.subarray(mdhd.start, mdhd.start + mdhd.size),
          durationSeconds,
        ),
        mdhd.start,
      );
    }
  }
  return out;
}

export function buildMuxedInitSegment(
  videoInit: Uint8Array,
  audioInit: Uint8Array,
  durationSeconds: number | null | undefined,
  audioTrackId: number = 2,
): Uint8Array {
  const vFtyp = findMp4Box(videoInit, "ftyp");
  const vMoov = findMp4Box(videoInit, "moov");
  const aMoov = findMp4Box(audioInit, "moov");
  if (!vMoov || !aMoov) return videoInit;

  const vi = vMoov.start + vMoov.headerSize;
  const ve = vMoov.start + vMoov.size;
  const ai = aMoov.start + aMoov.headerSize;
  const ae = aMoov.start + aMoov.size;

  const vMvhd = findMp4Box(videoInit, "mvhd", vi, ve);
  const vTrak = findMp4Box(videoInit, "trak", vi, ve);
  const aTrak = findMp4Box(audioInit, "trak", ai, ae);
  const vMvex = findMp4Box(videoInit, "mvex", vi, ve);
  const aMvex = findMp4Box(audioInit, "mvex", ai, ae);
  if (!vMvhd || !vTrak || !aTrak || !vMvex || !aMvex) return videoInit;

  const vTrex = findMp4Box(
    videoInit,
    "trex",
    vMvex.start + vMvex.headerSize,
    vMvex.start + vMvex.size,
  );
  const aTrex = findMp4Box(
    audioInit,
    "trex",
    aMvex.start + aMvex.headerSize,
    aMvex.start + aMvex.size,
  );
  if (!vTrex || !aTrex) return videoInit;

  const { box: mvhdData, timescale: movieTimescale } = patchMvhdDuration(
    videoInit.subarray(vMvhd.start, vMvhd.start + vMvhd.size),
    durationSeconds,
  );

  const videoTrak = cleanMp4BoxTree(
    patchTrakDuration(
      videoInit.subarray(vTrak.start, vTrak.start + vTrak.size),
      durationSeconds,
      movieTimescale,
    ),
  );

  let audioTrak = patchTrakDuration(
    audioInit.subarray(aTrak.start, aTrak.start + aTrak.size),
    durationSeconds,
    movieTimescale,
  );
  const audioTkhd = findMp4Box(audioTrak, "tkhd", 8);
  if (audioTkhd) {
    audioTrak.set(
      replaceFullBoxTrackId(
        audioTrak.subarray(audioTkhd.start, audioTkhd.start + audioTkhd.size),
        audioTrackId,
      ),
      audioTkhd.start,
    );
  }
  audioTrak = cleanMp4BoxTree(audioTrak);

  const newMvex = makeMp4Box(
    "mvex",
    concatUint8Arrays(
      videoInit.subarray(vTrex.start, vTrex.start + vTrex.size),
      replaceFullBoxTrackId(
        audioInit.subarray(aTrex.start, aTrex.start + aTrex.size),
        audioTrackId,
      ),
    ),
  );

  const newMoov = makeMp4Box(
    "moov",
    concatUint8Arrays(mvhdData, videoTrak, audioTrak, newMvex),
  );

  return concatUint8Arrays(
    vFtyp
      ? videoInit.subarray(vFtyp.start, vFtyp.start + vFtyp.size)
      : new Uint8Array(0),
    newMoov,
  );
}
