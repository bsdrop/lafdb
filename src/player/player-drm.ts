import { findMp4Box, parseMp4Boxes, parseSenc, parseTfhd, parseTrun, stripDrmAuxBoxesFromFragment } from "./mp4-box";

type TrackType = "audio" | "video";

interface DecryptContext {
  key: CryptoKey;
  trunView: DataView;
  trunFlags: number;
  trunSamples: number;
  defaultSampleSize: number;
  sencSamples: ReturnType<typeof parseSenc>["samples"];
  mdatPayload: Uint8Array;
}

function inferTrackType(trackType?: string | null): TrackType {
  return trackType === "audio" ? "audio" : "video";
}

async function decryptTrackSamples(kind: TrackType, ctx: DecryptContext): Promise<void> {
  const count = Math.min(ctx.sencSamples.length, ctx.trunSamples);
  let trunOff = 8;
  if (ctx.trunFlags & 0x01) trunOff += 4;
  if (ctx.trunFlags & 0x04) trunOff += 4;
  let mdatOffset = 0;

  for (let i = 0; i < count; i++) {
    const sencSample = ctx.sencSamples[i];
    const iv = sencSample.iv;

    let sampleSize = ctx.defaultSampleSize;
    if (ctx.trunFlags & 0x100) trunOff += 4;
    if (ctx.trunFlags & 0x200) {
      sampleSize = ctx.trunView.getUint32(trunOff);
      trunOff += 4;
    }
    if (ctx.trunFlags & 0x400) trunOff += 4;
    if (ctx.trunFlags & 0x800) trunOff += 4;

    const subsamples = sencSample.subsamples.length > 0 ? sencSample.subsamples : [{ clear: 0, enc: sampleSize }];

    const totalEnc = subsamples.reduce((s, x) => s + x.enc, 0);
    const totalSize = subsamples.reduce((s, x) => s + x.clear + x.enc, 0);
    if (sampleSize <= 0) {
      throw new Error(`${kind}: invalid decrypted sample size`);
    }
    if (totalSize > sampleSize) {
      throw new Error(`${kind}: subsample sizes exceed sample size`);
    }
    if (mdatOffset + sampleSize > ctx.mdatPayload.length) {
      throw new Error(`${kind}: sample exceeds mdat payload`);
    }
    if (totalEnc > 0) {
      const encBuf = new Uint8Array(totalEnc);
      let gOff = 0;
      let rOff = mdatOffset;
      for (const sub of subsamples) {
        rOff += sub.clear;
        if (sub.enc > 0) {
          encBuf.set(ctx.mdatPayload.subarray(rOff, rOff + sub.enc), gOff);
          gOff += sub.enc;
          rOff += sub.enc;
        }
      }
      const counter = new Uint8Array(16);
      counter.set(iv, 0);
      const decBuf = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-CTR", counter, length: 64 }, ctx.key, encBuf),
      );
      let sOff = 0;
      let wOff = mdatOffset;
      for (const sub of subsamples) {
        wOff += sub.clear;
        if (sub.enc > 0) {
          ctx.mdatPayload.set(decBuf.subarray(sOff, sOff + sub.enc), wOff);
          sOff += sub.enc;
          wOff += sub.enc;
        }
      }
    }
    mdatOffset += sampleSize;
  }
}

async function decryptAudioSegmentData(ctx: DecryptContext): Promise<void> {
  await decryptTrackSamples("audio", ctx);
}

async function decryptVideoSegmentData(ctx: DecryptContext): Promise<void> {
  await decryptTrackSamples("video", ctx);
}

export function stripDrmSignaling(initBuffer: Uint8Array, trackType: string): Uint8Array {
  const buf = new Uint8Array(initBuffer);
  const len = buf.length;
  const isAt = (i: number, a: number, b: number, c: number, d: number) =>
    buf[i] === a && buf[i + 1] === b && buf[i + 2] === c && buf[i + 3] === d;
  let d0: number, d1: number, d2: number, d3: number;
  if (trackType === "audio") {
    d0 = 109;
    d1 = 112;
    d2 = 52;
    d3 = 97;
  } else {
    d0 = 97;
    d1 = 118;
    d2 = 99;
    d3 = 49;
  }
  for (let i = 0; i <= len - 4; i++) {
    if (isAt(i, 101, 110, 99, 118) || isAt(i, 101, 110, 99, 97)) {
      let f0 = d0,
        f1 = d1,
        f2 = d2,
        f3 = d3;
      for (let j = i; j <= len - 8; j++) {
        if (isAt(j, 102, 114, 109, 97)) {
          f0 = buf[j + 4];
          f1 = buf[j + 5];
          f2 = buf[j + 6];
          f3 = buf[j + 7];
          break;
        }
      }
      buf[i] = f0;
      buf[i + 1] = f1;
      buf[i + 2] = f2;
      buf[i + 3] = f3;
      for (let j = i; j <= len - 4; j++) {
        if (isAt(j, 115, 105, 110, 102)) {
          buf[j] = 102;
          buf[j + 1] = 114;
          buf[j + 2] = 101;
          buf[j + 3] = 101;
          break;
        }
      }
    }
    if (isAt(i, 112, 115, 115, 104)) {
      buf[i] = 102;
      buf[i + 1] = 114;
      buf[i + 2] = 101;
      buf[i + 3] = 101;
    }
  }
  return buf;
}

export async function decryptSegment(
  data: Uint8Array,
  key: CryptoKey | null,
  trackType?: string,
): Promise<Uint8Array<ArrayBufferLike>> {
  if (!key) return data;
  const boxes = parseMp4Boxes(data);
  const moof = boxes.find((b) => b.type === "moof");
  if (!moof) return data;
  const traf = findMp4Box(moof.payload, "traf");
  if (!traf) return data;
  const senc = findMp4Box(traf.payload, "senc");
  const mdat = boxes.find((b) => b.type === "mdat");
  const tfhd = findMp4Box(traf.payload, "tfhd");
  const trun = findMp4Box(traf.payload, "trun");
  if (!senc || !mdat || !tfhd || !trun) return data;

  const tfhdInfo = parseTfhd(tfhd.payload);
  const trunInfo = parseTrun(trun.payload);
  const defaultSampleSize = tfhdInfo.defaultSampleSize ?? 0;
  const kind = inferTrackType(trackType);

  const trunView = new DataView(trun.payload.buffer, trun.payload.byteOffset, trun.payload.byteLength);
  const trunFlags = trunInfo.flags;
  const trunSamples = trunInfo.sampleCount;
  const sencInfo = parseSenc(senc.payload);
  const mdatPayload = new Uint8Array(mdat.payload);
  const ctx: DecryptContext = {
    key,
    trunView,
    trunFlags,
    trunSamples,
    defaultSampleSize,
    sencSamples: sencInfo.samples,
    mdatPayload,
  };
  if (kind === "audio") {
    await decryptAudioSegmentData(ctx);
  } else {
    await decryptVideoSegmentData(ctx);
  }

  const drmAuxBoxes = new Set(["senc", "saiz", "saio", "sbgp", "sgpd"]);
  let result = new Uint8Array(data);
  for (let i = 0; i < result.length - 4; i++) {
    if (
      result[i] === 112 &&
      result[i + 1] === 115 &&
      result[i + 2] === 115 &&
      result[i + 3] === 104
    ) {
      result.set([102, 114, 101, 101], i);
    }
  }
  result.set(mdatPayload, mdat.start + mdat.headerSize);
  return stripDrmAuxBoxesFromFragment(result, drmAuxBoxes);
}
