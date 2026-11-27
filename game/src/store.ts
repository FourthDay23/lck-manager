// One mutable game state, plus a version counter the UI subscribes to.
import { useEffect, useState } from "preact/hooks";
import type { GameData } from "./data/load";
import type { GameState } from "./core/types";

type Listener = () => void;

export interface Screen { name: string; arg?: string }

class Store {
  data: GameData | null = null;
  s: GameState | null = null;
  slot = 1;
  screen: Screen = { name: "home" };
  toast: { text: string; at: number } | null = null;
  modal: { kind: string; arg?: string; arg2?: string } | null = null;
  /** While the code-match screen is open, screens read this throwaway state instead of the career save. */
  override: GameState | null = null;
  exState: GameState | null = null;
  /** Tutorial part and step being shown (ui/Tutorial.tsx), null when off. */
  tut: { part: string; i: number } | null = null;
  /** One-time tip being shown (ui/Tutorial.tsx tipOnce), null when off. */
  tip: { key: string; sel?: string; text?: string; title: string; body: string } | null = null;
  open(kind: string, arg?: string, arg2?: string) {
    this.modal = { kind, arg, arg2 };
    this.bump();
  }
  close() {
    this.modal = null;
    this.bump();
  }
  private listeners = new Set<Listener>();
  private ver = 0;

  bump() {
    this.ver++;
    for (const l of this.listeners) l();
  }
  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  go(name: string, arg?: string) {
    this.screen = { name, arg };
    this.bump();
  }
  say(text: string) {
    this.toast = { text, at: Date.now() };
    this.bump();
    setTimeout(() => {
      if (this.toast && Date.now() - this.toast.at >= 2900) {
        this.toast = null;
        this.bump();
      }
    }, 3000);
  }
  get version() {
    return this.ver;
  }
}

export const store = new Store();

export function useStore(): Store {
  const [, setV] = useState(0);
  useEffect(() => {
    const unsub = store.subscribe(() => setV((v) => v + 1));
    return () => {
      unsub();
    };
  }, []);
  return store;
}

export function S(): GameState {
  if (store.override) return store.override;
  if (!store.s) throw new Error("no game");
  return store.s;
}
export function D(): GameData {
  if (!store.data) throw new Error("no data");
  return store.data;
}
