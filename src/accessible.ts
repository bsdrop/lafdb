export {};

declare global {
  interface Window {
    isAccessibleItem: (id: number) => boolean;
    isAccessibleEpisode: (id: number) => boolean;
  }
}

const MIN_ITEM_ID: number = 0;
const MAX_ITEM_ID: number = 0;
const bitsetBufItem: Uint32Array = new Uint32Array([]);
function hasItem(id: number): boolean {
  if (id < MIN_ITEM_ID || id > MAX_ITEM_ID) return false;
  const o = id - MIN_ITEM_ID;
  return (bitsetBufItem[o >>> 5] & (1 << (o & 31))) !== 0;
}
window.isAccessibleItem = hasItem;

const MIN_EPISODE_ID: number = 0;
const MAX_EPISODE_ID: number = 0;
const bitsetBufEpisode: Uint32Array = new Uint32Array([]);
function hasEpisode(id: number): boolean {
  if (id < MIN_EPISODE_ID || id > MAX_EPISODE_ID) return false;
  const o = id - MIN_EPISODE_ID;
  return (bitsetBufEpisode[o >>> 5] & (1 << (o & 31))) !== 0;
}
window.isAccessibleEpisode = hasEpisode;
