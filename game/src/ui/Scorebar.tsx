// Broadcast-style top bar for the match screen, modelled on the LCK broadcast HUD:
// team blocks with series pips, towers and gold on the outside, kills in the middle,
// a second row with grubs / barons / dragons and the game clock, objective timers on the left.
// The icons are the League client's own (cut by scripts/build_hud_icons.py into public/assets/hud/).
import type { Engine } from "../match/engine";
import { S } from "../store";
import { fmtClock } from "../core/format";
import { TeamLogo } from "./components";
import "./scorebar.css";

/** The series this game belongs to, by team id (not by side: sides swap between games). */
export interface SeriesInfo {
  teams: [string, string];
  wins: [number, number];
  bo: number;
  /** competition and stage, e.g. "LCK 정규 시즌 1·2R · 정규 라운드" */
  label: string;
  /** which game of the series, e.g. "2세트 · Bo3" */
  game: string;
  /** small line under the label (fearless count, patch) */
  note?: string;
  /** small line under each team's short name, by team id (league rank, region) */
  sub?: Record<string, string>;
}

/** engine dragon type (Korean) -> the icon file's element name */
const ELEMENT: Record<string, string> = {
  화염: "fire", 대지: "earth", 바다: "water", 바람: "air", 화학공학: "chemtech", 마법공학: "hextech", 장로: "elder",
};

function Ico({ src, size, title }: { src: string; size: number; title: string }) {
  return <img class="sb-ico" src={`assets/hud/${src}`} width={size} height={size} alt={title} title={title} draggable={false} />;
}
export const DrakeIcon = ({ type, size = 20 }: { type: string; size?: number }) =>
  <Ico src={`drake_${ELEMENT[type] ?? "elder"}.png`} size={size} title={`${type} 드래곤`} />;
const SoulIcon = ({ type, size = 24 }: { type: string; size?: number }) =>
  ELEMENT[type] && type !== "장로" ? <Ico src={`soul_${ELEMENT[type]}.png`} size={size} title={`${type} 드래곤의 영혼`} /> : null;
const TowerIcon = ({ size = 22 }: { size?: number }) => <Ico src="tower.png" size={size} title="포탑" />;
const CoinIcon = ({ size = 22 }: { size?: number }) => <Ico src="gold.png" size={size} title="골드" />;
const SwordsIcon = ({ size = 26 }: { size?: number }) => <Ico src="swords.svg" size={size} title="킬" />;
const GrubIcon = ({ size = 20 }: { size?: number }) => <Ico src="grub.png" size={size} title="공허 유충" />;
const BaronIcon = ({ size = 20 }: { size?: number }) => <Ico src="baron.png" size={size} title="내셔 남작" />;
const HeraldIcon = ({ size = 20 }: { size?: number }) => <Ico src="herald.png" size={size} title="협곡의 전령" />;

const k1 = (g: number) => `${(g / 1000).toFixed(1)}K`;

/** the objective timer on the top side of the map (grubs → herald → baron) and the one at the dragon pit */
function objTimers(e: Engine) {
  const tm = e.timers();
  const by = (k: string) => tm.find((t) => t.key === k)!;
  const pickNext = (keys: string[]) => {
    const list = keys.map(by).filter((t) => t.alive || (t.at !== null && t.at > e.t));
    // something up now wins; otherwise whatever comes first
    return list.find((t) => t.alive) ?? list.sort((a, b) => a.at! - b.at!)[0] ?? null;
  };
  const top = pickNext(["baron", "herald", "grubs"]);
  const elder = by("elder");
  const pit = elder.alive || (elder.at !== null && e.soul !== null) ? elder : pickNext(["dragon"]);
  return { top, pit };
}

/** of the two, only the one that comes up first (one that is up now counts as 0; baron and elder win a tie) */
function firstTimer(e: Engine) {
  const { top, pit } = objTimers(e);
  type T = NonNullable<typeof top>;
  const left = (t: T) => (t.alive ? 0 : t.at === null ? Infinity : t.at - e.t);
  const big = (t: T) => (t.key === "baron" || t.key === "elder" ? 0 : 1);
  return [top, pit].filter((t): t is T => !!t).sort((a, b) => left(a) - left(b) || big(a) - big(b))[0] ?? null;
}

function TimerChip({ e, t }: { e: Engine; t: { key: string; at: number | null; alive: boolean } }) {
  const icon =
    t.key === "baron" ? <BaronIcon size={28} /> :
    t.key === "herald" ? <HeraldIcon size={28} /> :
    t.key === "grubs" ? <GrubIcon size={26} /> :
    t.key === "elder" ? <DrakeIcon type="장로" size={28} /> :
    <DrakeIcon type={e.obj.dragon.type ?? ""} size={28} />;
  // the voidgrubs die one by one: how many are left, and a pip per grub in the colour of the team that took it
  if (t.key === "grubs" && t.alive) {
    return (
      <div class="sb-timer up grubs" title="남은 공허 유충">
        {icon}
        <b>{e.obj.grubs.left ?? 3}마리</b>
        <span class="sb-gpips">
          {e.grubUnits.map((g) => <i class={g.alive ? "live" : g.takenBy === 0 ? "blue" : g.takenBy === 1 ? "red" : "gone"} />)}
        </span>
      </div>
    );
  }
  return (
    <div class={`sb-timer ${t.alive ? "up" : ""} ${t.key}`}>
      {icon}
      <b>{t.alive ? "등장" : t.at === null ? "—" : fmtClock(t.at - e.t)}</b>
    </div>
  );
}

export function Scorebar({ e, series }: { e: Engine; series?: SeriesInfo }) {
  const s = S();
  const g = [e.gold(0), e.gold(1)];
  const diff = g[0] - g[1];
  const next = firstTimer(e);
  const need = series ? Math.ceil(series.bo / 2) : 0;
  const winsOf = (side: 0 | 1) => {
    if (!series) return 0;
    const i = series.teams.indexOf(e.teamIds[side]);
    return i < 0 ? 0 : series.wins[i];
  };
  const buffLeft = (side: 0 | 1, key: "baronUntil" | "elderUntil") =>
    Math.max(0, ...e.units.filter((u) => u.side === side && u.alive).map((u) => u[key] - e.t));

  const team = (side: 0 | 1) => {
    const id = e.teamIds[side];
    const t = s.teams[id];
    const sub = series?.sub?.[id] ?? t?.name ?? "";
    const w = winsOf(side);
    const lead = side === 0 ? diff : -diff;
    return (
      <div class={`sb-team ${side ? "red" : "blue"}`}>
        {series && series.bo > 1 && (
          <div class="sb-pips" title={`시리즈 ${w}승 (Bo${series.bo})`}>
            {Array.from({ length: need }, (_, i) => <i class={i < w ? "on" : ""} />)}
          </div>
        )}
        <div class="sb-logo"><TeamLogo id={id} size={36} /></div>
        <div class="sb-name">
          <b>{t?.short ?? e.names[side]}</b>
          <small>{sub}</small>
        </div>
        <div class="sb-stat tower"><TowerIcon /><b>{e.towers[side]}</b></div>
        <div class="sb-stat gold">
          <CoinIcon />
          <b>{k1(g[side])}</b>
          {lead >= 100 && <span class="sb-diff">+{k1(lead)}</span>}
        </div>
      </div>
    );
  };

  const objs = (side: 0 | 1) => {
    const baron = buffLeft(side, "baronUntil");
    const elder = buffLeft(side, "elderUntil");
    const soul = e.soul === side;
    return (
      <div class={`sb-objs ${side ? "red" : "blue"}`}>
        <span class={`sb-cnt ${e.grubs[side] ? "" : "zero"}`} title={`공허 유충 ${e.grubs[side]}마리 (구조물 피해 +${Math.round((e.grubSiege(side) - 1) * 100)}%)`}><GrubIcon /><b>{e.grubs[side]}</b></span>
        <span class={`sb-cnt ${e.barons[side] ? "" : "zero"}`}><BaronIcon /><b>{e.barons[side]}</b></span>
        <span class={`sb-drakes ${soul ? "soul" : ""}`}>
          {e.dragons[side].map((d) => <DrakeIcon type={d} />)}
          {soul && <span class="sb-soul"><SoulIcon type={e.soulType} /></span>}
        </span>
        {baron > 0 && <span class="sb-buff baron" title="내셔 남작 버프 남은 시간"><BaronIcon size={16} />{fmtClock(baron)}</span>}
        {elder > 0 && <span class="sb-buff elder" title="장로 드래곤 버프 남은 시간"><DrakeIcon type="장로" size={16} />{fmtClock(elder)}</span>}
      </div>
    );
  };

  return (
    <div class="sb-wrap">
      <div class="sb">
        <div class="sb-side left">
          {next && <TimerChip e={e} t={next} />}
        </div>
        <div class="sb-center">
          <div class="sb-main">
            {team(0)}
            <div class="sb-kills">
              <b class="blue">{e.kills[0]}</b>
              <SwordsIcon />
              <b class="red">{e.kills[1]}</b>
            </div>
            {team(1)}
          </div>
          <div class="sb-sub">
            {objs(0)}
            <div class="sb-clock">{fmtClock(e.t)}</div>
            {objs(1)}
          </div>
        </div>
        <div class="sb-side right">
          {series && (
            <div class="sb-series">
              <b>{series.game}</b>
              <span>{series.label}</span>
              {series.note && <small>{series.note}</small>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
