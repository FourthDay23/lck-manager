import type { GameState, NewsItem } from "./types";

let seq = 0;
export function addNews(s: GameState, item: Omit<NewsItem, "id" | "day"> & { day?: number }) {
  seq += 1;
  const n: NewsItem = { id: `n${s.day}-${seq}-${s.news.length}`, day: item.day ?? s.day, ...item };
  if (!n.mine && s.user && (n.teams?.includes(s.user) ?? false)) n.mine = true;
  s.news.unshift(n);
  if (s.news.length > 600) s.news.length = 600;
}

export function inbox(s: GameState, text: string) {
  seq += 1;
  s.inbox.unshift({ id: `m${s.day}-${seq}-${s.inbox.length}`, day: s.day, text });
  if (s.inbox.length > 200) s.inbox.length = 200;
}

export function teamName(s: GameState, id: string | null | undefined): string {
  if (!id) return "FA";
  return s.teams[id]?.name ?? id;
}
