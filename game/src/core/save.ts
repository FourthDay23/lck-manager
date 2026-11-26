import { get, set, del } from "idb-keyval";
import LZString from "lz-string";
import type { GameState } from "./types";
import { SAVE_VERSION } from "./game";
import { fmtDate } from "./format";

export interface SlotMeta { slot: number; team: string; teamName: string; day: number; season: number; savedAt: number; label: string }

const KEY = (n: number) => `lckmgr_slot_${n}`;
const META = (n: number) => `lckmgr_slot_${n}_meta`;

export async function saveGame(s: GameState, slot: number) {
  const packed = "LZ1:" + LZString.compressToUTF16(JSON.stringify(s));
  const prev = await get(KEY(slot));
  if (prev) await set(KEY(slot) + "_bak", prev);
  await set(KEY(slot), packed);
  const meta: SlotMeta = {
    slot, team: s.user, teamName: s.teams[s.user]?.name ?? s.user, day: s.day, season: s.season, savedAt: Date.now(),
    label: `${s.teams[s.user]?.name} · ${fmtDate(s.day)}`,
  };
  localStorage.setItem(META(slot), JSON.stringify(meta));
}

export async function loadGame(slot: number): Promise<GameState | null> {
  const raw = (await get(KEY(slot))) as string | undefined;
  if (!raw) return null;
  const json = raw.startsWith("LZ1:") ? LZString.decompressFromUTF16(raw.slice(4)) : raw;
  if (!json) return null;
  const s = JSON.parse(json) as GameState;
  if (s.version !== SAVE_VERSION) console.warn("save version", s.version);
  return s;
}

export function slotMeta(slot: number): SlotMeta | null {
  const raw = localStorage.getItem(META(slot));
  return raw ? (JSON.parse(raw) as SlotMeta) : null;
}

export async function deleteSlot(slot: number) {
  await del(KEY(slot));
  await del(KEY(slot) + "_bak");
  localStorage.removeItem(META(slot));
}

// ---------- save files: move a career between browsers, devices, or http/https addresses ----------
const FILE_PREFIX = "LCKMSAVE1:";

/** Download the career as a small text file. */
export function downloadSave(s: GameState) {
  const text = FILE_PREFIX + LZString.compressToBase64(JSON.stringify(s));
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  const team = s.teams[s.user]?.short ?? "save";
  a.href = URL.createObjectURL(blob);
  a.download = `lck-manager-${team}-${s.season}-${s.day}.lckm`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Read a save file made by downloadSave. Returns null with a reason when it is not one. */
export async function readSaveFile(file: File): Promise<{ s: GameState } | { error: string }> {
  const text = (await file.text()).trim();
  if (!text.startsWith(FILE_PREFIX)) return { error: "LCK 매니저 세이브 파일이 아닙니다." };
  try {
    const json = LZString.decompressFromBase64(text.slice(FILE_PREFIX.length));
    const s = JSON.parse(json ?? "") as GameState;
    if (!s || !s.teams || !s.players || !s.user) return { error: "세이브 내용이 비어 있습니다." };
    return { s };
  } catch {
    return { error: "세이브 파일이 손상됐습니다." };
  }
}
