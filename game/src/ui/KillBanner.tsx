// Kill banners on the match board, like the broadcast's kill announcements: who killed whom (champion, player, team
// colour), with first blood, solo kills, shutdowns, multikills and aces shown bigger. The engine logs one kill as a
// "kill" / "first_blood" / "solo" event, then maybe "shutdown", "double".."penta" and "ace" at the same time
// (engine.ts kill). At 8x-64x kills come faster than banners can be read, so kills are merged into the banner they
// belong to (the same killer's multikill, the same fight) and a backlog makes each banner shorter.
import type { Engine, GameEvent } from "../match/engine";
import { S } from "../store";
import { ROLE_KO } from "../data/types";
import { ChampIcon, TeamLogo } from "./components";
import "./killbanner.css";

export type KillTag = "first_blood" | "solo" | "shutdown" | "double" | "triple" | "quadra" | "penta" | "ace";
const RANK: Record<KillTag, number> = { solo: 1, shutdown: 2, first_blood: 3, double: 4, triple: 5, ace: 6, quadra: 7, penta: 8 };
export const KILL_TAG_KO: Record<KillTag, string> = {
  first_blood: "퍼스트 블러드", solo: "솔로 킬", shutdown: "셧다운", double: "더블 킬", triple: "트리플 킬", quadra: "쿼드라 킬", penta: "펜타 킬", ace: "에이스",
};
const MULTI = new Set<KillTag>(["double", "triple", "quadra", "penta"]);
/** every event type that belongs to a kill (the objective banners leave these to the kill banner) */
export const KILL_EV = new Set<GameEvent["type"]>(["kill", "first_blood", "solo", "shutdown", "double", "triple", "quadra", "penta", "ace"]);

/** one kill: killer unit (-1 = a turret or minions, "처형"), victim, and what was special about it */
interface Pair { k: number; v: number; tags: KillTag[] }
export interface KillBan {
  id: number;
  side: 0 | 1;
  pairs: Pair[];
  ace: boolean;
  /** game time of the last kill merged in */
  t: number;
  /** real time (ms) the last kill came in */
  at: number;
  /** real time (ms) the banner went up; restarted when a kill or a tag is merged into it while it shows */
  start: number;
  /** bumps on every merge while showing, so the banner pops again */
  rev: number;
}

const tagsOf = (b: KillBan): KillTag[] => [...(b.ace ? ["ace" as KillTag] : []), ...b.pairs.flatMap((p) => p.tags)];
const rankOf = (b: KillBan) => tagsOf(b).reduce((m, t) => Math.max(m, RANK[t]), 0);
const topTag = (tags: KillTag[]) => tags.reduce<KillTag | null>((m, t) => (!m || RANK[t] > RANK[m] ? t : m), null);
/** how long a banner stays up with nothing waiting (ms): plain kills short, triple kills and up long */
function durOf(b: KillBan) {
  const r = rankOf(b);
  return (r >= RANK.triple ? 3200 : r > 0 ? 2500 : 1900) + Math.min(750, (b.pairs.length - 1) * 250);
}

export class KillQueue {
  cur: KillBan | null = null;
  pend: KillBan[] = [];
  private seq = 0;
  clear() {
    this.cur = null;
    this.pend = [];
  }
  /** banners still on screen or waiting, newest first */
  private recent() {
    const out = [...this.pend].reverse();
    if (this.cur) out.push(this.cur);
    return out;
  }
  push(ev: GameEvent, now: number) {
    if (ev.type === "kill" || ev.type === "first_blood" || ev.type === "solo") this.kill(ev, now);
    else this.tag(ev, now);
    this.trim();
  }
  private kill(ev: GameEvent, now: number) {
    if (ev.victim === undefined) return;
    const k = ev.actor ?? -1;
    const pair: Pair = { k, v: ev.victim, tags: ev.type === "kill" ? [] : [ev.type as KillTag] };
    const mine = this.recent().filter((b) => b.side === ev.side);
    // the same killer going on (a multikill: 10 s, 30 s after a quadra), the same fight (4 game seconds, or 0.6 s on
    // screen: at 64x that is half a minute of game), or with two banners already waiting, the newest waiting one of
    // this team (20 s)
    const into =
      mine.find((b) => k >= 0 && b.pairs.every((p) => p.k === k) && ev.t - b.t <= (b.pairs.length >= 4 ? 30 : 10)) ??
      mine.find((b) => ev.t - b.t <= 4 || now - b.at <= 600) ??
      (this.pend.length >= 2 ? mine.find((b) => b !== this.cur && ev.t - b.t <= 20) : undefined);
    if (into) {
      into.pairs.push(pair);
      into.t = ev.t;
      into.at = now;
      this.touch(into, now);
      return;
    }
    this.pend.push({ id: ++this.seq, side: ev.side, pairs: [pair], ace: false, t: ev.t, at: now, start: 0, rev: 0 });
  }
  /** shutdown / double..penta / ace: onto the kill they come with (logged right after it) */
  private tag(ev: GameEvent, now: number) {
    const t = ev.type as KillTag;
    for (const b of this.recent()) {
      if (b.side !== ev.side) continue;
      if (t === "ace") {
        if (b.pairs.some((p) => p.v === ev.victim)) {
          b.ace = true;
          this.touch(b, now);
          return;
        }
        continue;
      }
      for (let i = b.pairs.length - 1; i >= 0; i--) {
        const p = b.pairs[i];
        if (p.k !== ev.actor || (t === "shutdown" && p.v !== ev.victim)) continue;
        // a triple kill replaces the same player's double kill
        if (MULTI.has(t)) for (const q of b.pairs) if (q.k === p.k) q.tags = q.tags.filter((x) => !MULTI.has(x));
        p.tags.push(t);
        this.touch(b, now);
        return;
      }
    }
  }
  private touch(b: KillBan, now: number) {
    if (b === this.cur) {
      b.start = now;
      b.rev++;
    }
  }
  /** at most three waiting: merge neighbours of the same team, else drop the plainest */
  private trim() {
    while (this.pend.length > 3) {
      const i = this.pend.findIndex((b, j) => j + 1 < this.pend.length && this.pend[j + 1].side === b.side);
      if (i >= 0) {
        const a = this.pend[i], b = this.pend[i + 1];
        a.pairs.push(...b.pairs);
        a.ace ||= b.ace;
        a.t = Math.max(a.t, b.t);
        a.at = Math.max(a.at, b.at);
        this.pend.splice(i + 1, 1);
      } else {
        let w = 0;
        for (let j = 1; j < this.pend.length; j++) if (rankOf(this.pend[j]) < rankOf(this.pend[w])) w = j;
        this.pend.splice(w, 1);
      }
    }
  }
  /** with banners waiting, the one up goes sooner (never under 1 s, 1.6 s for a triple kill or more) */
  private effDur(b: KillBan) {
    const n = this.pend.length;
    const f = n >= 2 ? 0.5 : n === 1 ? 0.7 : 1;
    return Math.max(rankOf(b) >= RANK.triple ? 1600 : 1000, durOf(b) * f);
  }
  left(now: number) {
    return this.cur ? this.cur.start + this.effDur(this.cur) - now : 0;
  }
  /** take the banner down when its time is up and put up the next one */
  tick(now: number) {
    if (this.cur && this.left(now) <= 0) this.cur = null;
    if (!this.cur && this.pend.length) {
      this.cur = this.pend.shift()!;
      this.cur.start = now;
    }
  }
}

/** crossed swords between killer and victim */
function Swords({ size = 22 }: { size?: number }) {
  const d = "M3 3L15 15M21 3L9 15M12 18L18 12M6 12L12 18M16.5 16.5L21 21M7.5 16.5L3 21";
  return (
    <svg class="kb-x" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} stroke="#05070d" stroke-width="5" fill="none" stroke-linecap="square" />
      <path d={d} stroke="#f4f6fb" stroke-width="2.4" fill="none" stroke-linecap="square" />
    </svg>
  );
}

export function KillBanner({ e, q, now }: { e: Engine; q: KillQueue; now: number }) {
  const b = q.cur;
  if (!b) return null;
  const s = S();
  const teamId = e.teamIds[b.side], foeId = e.teamIds[1 - b.side];
  const team = s.teams[teamId], foe = s.teams[foeId];
  const r = rankOf(b);
  const mega = r >= RANK.triple;
  const out = q.left(now) < 320;
  const cls = `kb ${b.side ? "red" : "blue"} ${mega ? "mega" : r > 0 ? "special" : ""} ${out ? "out" : ""}`;
  const killers = [...new Set(b.pairs.map((p) => p.k))];
  const unit = (i: number) => (i >= 0 ? e.units[i] : null);

  if (killers.length === 1) {
    // one player's kill(s): killer on the left in the team's colour, victim(s) greyed on the right
    const ku = unit(killers[0]);
    const tags = tagsOf(b);
    const main = topTag(tags);
    const extra = [...new Set(tags.filter((t) => t !== main))].sort((x, y) => RANK[y] - RANK[x]);
    const vics = b.pairs.map((p) => p.v);
    const vu = e.units[vics[vics.length - 1]];
    const label = main ? KILL_TAG_KO[main] : vics.length > 1 ? `${vics.length}킬` : "";
    return (
      <div class={cls} key={`${b.id}-${b.rev}`}>
        {label && <div class={`kb-label t-${main ?? "multi"}`}>{label}</div>}
        <div class="kb-body">
          <div class="kb-who killer">
            {ku ? <ChampIcon id={ku.champ.id} size={mega ? 52 : 44} /> : <span class="kb-tower">포탑</span>}
            <div class="kb-name">
              <small><TeamLogo id={teamId} size={14} />{team.short}{ku ? ` · ${ROLE_KO[ku.role]}` : ""}</small>
              <b>{ku ? ku.name : "처형"}</b>
            </div>
          </div>
          <Swords size={mega ? 26 : 22} />
          <div class="kb-who victim">
            {vics.length === 1 ? (
              <>
                <div class="kb-name right">
                  <small>{ROLE_KO[vu.role]} · {foe.short}<TeamLogo id={foeId} size={14} /></small>
                  <b>{vu.name}</b>
                </div>
                <ChampIcon id={vu.champ.id} size={mega ? 52 : 44} />
              </>
            ) : (
              <div class="kb-vics">{vics.map((v) => <ChampIcon id={e.units[v].champ.id} size={vics.length > 3 ? 30 : 36} title={e.units[v].name} />)}</div>
            )}
          </div>
        </div>
        {extra.length > 0 && <div class="kb-extra">{extra.map((t) => <span class={`kb-chip t-${t}`}>{KILL_TAG_KO[t]}</span>)}</div>}
      </div>
    );
  }

  // kills by several players merged (a fight at high speed): one line per kill under the team's header
  const best = b.pairs.map((p) => ({ p, t: topTag(p.tags) })).filter((x) => x.t && RANK[x.t] >= RANK.triple).sort((x, y) => RANK[y.t!] - RANK[x.t!])[0];
  const head = b.ace ? `에이스! ${team.short}` : best ? `${unit(best.p.k)?.name ?? ""} ${KILL_TAG_KO[best.t!]}` : `${team.short} ${b.pairs.length}킬`;
  const rows = b.pairs.slice(-4);
  return (
    <div class={`${cls} rows`} key={`${b.id}-${b.rev}`}>
      <div class={`kb-label ${mega ? "t-ace" : "t-team"}`}><TeamLogo id={teamId} size={16} />{head}</div>
      <div class="kb-rows">
        {rows.map((p) => {
          const ku = unit(p.k), vu = e.units[p.v];
          const t = topTag(p.tags);
          return (
            <div class="kb-row">
              {ku ? <ChampIcon id={ku.champ.id} size={26} /> : <span class="kb-tower small">탑</span>}
              <span class="kb-rn">{ku ? ku.name : "처형"}</span>
              <Swords size={16} />
              <span class="kb-vi"><ChampIcon id={vu.champ.id} size={26} /></span>
              <span class="kb-rn victim">{vu.name}</span>
              {t ? <span class={`kb-chip t-${t}`}>{KILL_TAG_KO[t]}</span> : <span />}
            </div>
          );
        })}
        {b.pairs.length > rows.length && <div class="kb-more">외 {b.pairs.length - rows.length}킬</div>}
      </div>
    </div>
  );
}
