// Builds and keystones: the coach's pick after the draft (LoadoutPicker) and the items a unit owns during a match
// (ItemStrip). Data: public/data/items.json via match/items.ts.
import { D } from "../store";
import { ROLES, ROLE_KO } from "../data/types";
import type { Role } from "../data/types";
import type { DraftState, Side } from "../match/draft";
import type { Engine, Unit } from "../match/engine";
import { champItems, itemImg, optionEdge, runeImg, unitItems } from "../match/items";
import type { ItemData, Loadout } from "../match/items";
import { ChampIcon } from "./components";
import "./loadout.css";

const pct = (w: number, n: number) => (n ? `${Math.round((w / n) * 100)}%` : "-");
function edgeTag(e: number) {
  const v = Math.round(e * 1000) / 10;
  if (Math.abs(v) < 0.3) return null;
  return <span class={v > 0 ? "pos" : "neg"}>{v > 0 ? "+" : ""}{v}%p</span>;
}

export function ItemIcon({ items, id, size = 18 }: { items: ItemData; id: number; size?: number }) {
  const it = items.items[String(id)];
  return <img class="item-ic" src={itemImg(items, id)} width={size} height={size} title={it ? `${it.name} (${it.cost}골드)` : String(id)} alt="" loading="lazy" />;
}

export function RuneIcon({ items, id, size = 18 }: { items: ItemData; id: number | null; size?: number }) {
  const k = id !== null ? items.keystones[String(id)] : undefined;
  if (!k) return null;
  return <img class="rune-ic" src={runeImg(k.icon)} width={size} height={size} title={`${k.name} (${k.treeName})`} alt="" loading="lazy" />;
}

/** After the draft: pick each player's keystone and core build among the champion's most played LCK options. */
export function LoadoutPicker({ d, side, onChange }: { d: DraftState; side: Side; onChange: () => void }) {
  const data = D();
  const items = data.items;
  if (!items) return null;
  const lo = (d.loadout ??= {});
  const mine = (lo[side] ??= {});
  const set = (r: Role, patch: Partial<Loadout>) => {
    mine[r] = { build: 0, keystone: 0, ...mine[r], ...patch };
    onChange();
  };
  return (
    <div class="loadout">
      <div class="row" style={{ justifyContent: "space-between" }}>
        <b>룬 · 빌드</b>
        <span class="muted" style={{ fontSize: 11 }}>LCK {items.games}경기 기준 · 승률 차는 표본 수를 감안해 줄인 값입니다</span>
      </div>
      {ROLES.map((r) => {
        const champ = d.picks[side][r];
        if (!champ) return null;
        const ci = champItems(items, champ, r);
        if (!ci) return null;
        const own = !!items.champs[champ];
        const cur = mine[r] ?? { build: 0, keystone: 0 };
        return (
          <div class="lo-row">
            <ChampIcon id={champ} size={28} />
            <div class="lo-name">
              <b>{data.champ.get(champ)?.name}</b>
              <div class="muted">{ROLE_KO[r]} · {own ? `${ci.n}판 ${pct(ci.w, ci.n)}` : "LCK 기록 없음(포지션 평균)"}</div>
            </div>
            <div class="lo-opts">
              {ci.keystones.slice(0, 3).map((k, i) => (
                <button class={`lo-opt ${cur.keystone === i ? "on" : ""}`} onClick={() => set(r, { keystone: i })} title={`${items.keystones[String(k.id)]?.name ?? k.id}: ${k.n}판 승률 ${pct(k.w, k.n)}`}>
                  <RuneIcon items={items} id={k.id} size={20} />
                  <span>{k.n}판 {pct(k.w, k.n)} {own ? edgeTag(optionEdge(ci, k.n, k.w)) : null}</span>
                </button>
              ))}
            </div>
            <div class="lo-opts">
              {ci.builds.slice(0, 3).map((b, i) => (
                <button class={`lo-opt ${cur.build === i ? "on" : ""}`} onClick={() => set(r, { build: i })} title={`${b.core.map((id) => items.items[String(id)]?.name ?? id).join(" → ")}: ${b.n}판 승률 ${pct(b.w, b.n)}`}>
                  {b.core.map((id) => <ItemIcon items={items} id={id} size={18} />)}
                  <span>{b.n}판 {pct(b.w, b.n)} {own ? edgeTag(optionEdge(ci, b.n, b.w)) : null}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** During a match: keystone and finished items of one unit. */
export function ItemStrip({ e, u }: { e: Engine; u: Unit }) {
  const x = unitItems(e, u);
  if (!x) return null;
  return (
    <div class="item-strip">
      <RuneIcon items={x.data} id={x.keystone} size={14} />
      {x.items.map((id) => <ItemIcon items={x.data} id={id} size={14} />)}
    </div>
  );
}
