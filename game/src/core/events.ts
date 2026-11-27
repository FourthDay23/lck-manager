// Choice events (design: docs/events_design.md).
// Three kinds reach the user: random events (at most 2 a week), low-morale events and aftermaths of earlier
// choices (neither counts toward the 2). One is shown at a time. Options say what may happen only in words:
// "~할 거예요" for 70% or more, "~할 수도 있어요" for 20-69%, nothing below 20%. The chances are fixed when the
// event is made and stored with it, so the words and the roll agree.
import type { GameData } from "../data/load";
import type { AttrKey, Role } from "../data/types";
import { ATTR_KEYS, ATTR_KO, ROLES, ROLE_KO } from "../data/types";
import { dateOf, money } from "./format";
import { addNews, inbox, teamName } from "./news";
import { age, lineupOvr, marketValue, ovr, salaryAsk } from "./player";
import { clamp, hashUnit, Rng } from "./rng";
import { seasonDates } from "./schedule";
import { joinTeam, releasePlayer, releaseStaff, windowOpen } from "./market";
import { academyOf, callUp, canCallUp } from "./academy";
import { earn, spend } from "./ledger";
import { facilityCost } from "./economy";
import { addMemo, countMemo, evState, hasMemo, weekStartOf } from "./evmemo";
import type { CompId, EvQueued, EvState, GameState, ModalEvent, Player, Series, Staff, Team } from "./types";

type Pol = "neg" | "pos";
type Cls = "random" | "morale" | "after";

interface Ctx {
  s: GameState;
  rng: Rng;
  data: GameData | null;
  t: Team;
  p: Player | null;
  q: Player | null;
  d: Record<string, number | string>;
  depth: number;
  def: string;
  lines: string[];
}
type Fx = (c: Ctx) => void;
interface Branch { p: number; hint?: string; hidden?: boolean; fx?: Fx }
interface Opt {
  label: string;
  cost?: number;
  avail?: boolean;
  /** what surely happens, worded "~할 거예요" */
  hint?: string;
  /** a fixed sentence shown as is */
  note?: string;
  always?: Fx;
  /** independent rolls; the branches inside one roll exclude each other (the rest of 1 is "nothing") */
  rolls?: Branch[][];
}
interface Def {
  id: string;
  pol: Pol;
  cls: Cls;
  team?: boolean;
  /** shown on the morning of a user match day only (random events) */
  matchDay?: boolean;
  /**
   * random: fills the context and returns a weight (0 = not now; special events return 3).
   * morale: returns the day's chance. after: checks the scheduled target is still valid (true when missing).
   */
  find?: (c: Ctx) => number | boolean;
  title: (c: Ctx) => string;
  body: (c: Ctx) => string;
  opts: (c: Ctx) => Opt[];
}

const RANDOM_DAILY = 0.2;
const RANDOM_WEEK_MAX = 2;
const MORALE_GAP = 3;
const MORALE_CD = 21;
const MAX_DEPTH = 2;
/**
 * Days before a player can be named by another random event. Each event has its own 60-day cooldown, but a star
 * meets the conditions of many (most famous, best, oldest), so without this he got one every two weeks or so.
 */
const RANDOM_PLAYER_GAP = 21;
const INTL: CompId[] = ["MSI", "EWC", "WORLDS"];

// ---------- small helpers ----------
const sg = (v: number) => (v > 0 ? `+${v}` : `${v}`);
const nm = (p: Player) => p.name;
const roster = (c: Ctx) => c.t.roster.map((id) => c.s.players[id]).filter((p): p is Player => !!p && !p.retired);
const starters = (c: Ctx) => ROLES.map((r) => c.t.lineup[r]).filter(Boolean).map((id) => c.s.players[id!]).filter(Boolean);
const isStarter = (c: Ctx, p: Player) => Object.values(c.t.lineup).includes(p.id);
const staffOf = (c: Ctx) => c.t.staff.map((id) => c.s.staff[id]).filter((x): x is Staff => !!x);
const headCoachOf = (c: Ctx) => staffOf(c).find((x) => x.role === "Head Coach") ?? staffOf(c)[0];
const motivate = (c: Ctx) => headCoachOf(c)?.attrs.motivate ?? 40;
const bestAnalysis = (c: Ctx) => Math.max(40, ...staffOf(c).map((x) => x.attrs.analysis));
/** a broken promise in the last year halves the odds of talking him round */
const trust = (c: Ctx, p: Player | null) => (p && hasMemo(c.s, p.id, "배신", 365) ? 0.5 : 1);
const cdOk = (c: Ctx, key: string, days: number) => c.s.day - (evState(c.s).cd[key] ?? -9999) >= days;
const lowestAttr = (p: Player): AttrKey => [...ATTR_KEYS].sort((a, b) => p.attrs[a] - p.attrs[b])[0];
const pickOne = <T,>(c: Ctx, xs: T[], w: (x: T) => number = () => 1): T | undefined => (xs.length ? c.rng.weighted(xs, w) : undefined);
/**
 * The one with the highest key. A tie is drawn at random: sorting and taking [0] hands every tie to the first in
 * roster order, and ties are common (signed rookies all start at fame 1, morale bottoms out at 0).
 */
const topBy = <T,>(c: Ctx, xs: T[], key: (x: T) => number): T | undefined => {
  if (!xs.length) return undefined;
  const best = Math.max(...xs.map(key));
  return pickOne(c, xs.filter((x) => key(x) === best));
};
/**
 * One of the team's top two by key, the leader twice as likely (ties at the cut drawn at random). For the
 * star events (most famous, oldest, best mechanics): a star still gets them more often, but no longer every one;
 * with one star on the team (Faker) he took 42-46% of all player events when each of these was his alone.
 */
const leaderPick = <T,>(c: Ctx, xs: T[], key: (x: T) => number, ok: (x: T) => boolean = () => true): T | undefined => {
  const top = c.rng.shuffle([...xs]).sort((a, b) => key(b) - key(a)).slice(0, 2);
  if (!top.length) return undefined;
  const best = key(top[0]);
  return pickOne(c, top.filter(ok), (x) => (key(x) === best ? 2 : 1));
};
const weightStar = (c: Ctx) => (p: Player) => (isStarter(c, p) ? 2 : 1);

function userSeriesOn(s: GameState, day: number): Series | undefined {
  return s.series.find((x) => x.day === day && !x.done && (x.a === s.user || x.b === s.user) && x.a && x.b);
}
function nextSeries(s: GameState): Series | undefined {
  return s.series.filter((x) => !x.done && (x.a === s.user || x.b === s.user) && x.day >= s.day).sort((a, b) => a.day - b.day)[0];
}
function lastSeries(s: GameState): Series | undefined {
  return s.series.filter((x) => x.done && (x.a === s.user || x.b === s.user)).sort((a, b) => a.day - b.day).at(-1);
}
function bigSeries(sr: Series | undefined): boolean {
  return !!sr && (sr.comp === "PO" || INTL.includes(sr.comp) || sr.stage === "F" || sr.stage === "SF");
}
const oppOf = (s: GameState, sr: Series) => (sr.a === s.user ? sr.b! : sr.a!);

// ---------- effects (each one adds a line to the result) ----------
function mo(c: Ctx, p: Player, v: number) {
  if (!v) return;
  p.morale = clamp(p.morale + v, 0, 100);
  c.lines.push(`${nm(p)} 사기 ${sg(v)}`);
}
function moList(c: Ctx, ps: Player[], v: number, who: string) {
  if (!v || !ps.length) return;
  for (const p of ps) p.morale = clamp(p.morale + v, 0, 100);
  c.lines.push(`${who} 사기 ${sg(v)}`);
}
function fat(c: Ctx, p: Player, v: number) {
  p.fatigue = clamp(p.fatigue + v, 0, 100);
  c.lines.push(`${nm(p)} 피로 ${sg(v)}`);
}
function fatList(c: Ctx, ps: Player[], v: number, who: string) {
  if (!ps.length) return;
  for (const p of ps) p.fatigue = clamp(p.fatigue + v, 0, 100);
  c.lines.push(`${who} 피로 ${sg(v)}`);
}
function form(c: Ctx, p: Player, v: number) {
  p.form = clamp(p.form + v, -10, 10);
  c.lines.push(`${nm(p)} 폼 ${sg(v)}`);
}
function syn(c: Ctx, v: number) {
  c.t.synergy = clamp(c.t.synergy + v, 0, 100);
  c.lines.push(`팀 합 ${sg(v)}`);
}
function tfame(c: Ctx, v: number) {
  c.t.fame = clamp(c.t.fame + v, 0, 100);
  c.lines.push(`구단 명성 ${sg(v)}`);
}
function pfame(c: Ctx, p: Player, v: number) {
  p.fame = clamp(p.fame + v, 0, 100);
  c.lines.push(`${nm(p)} 명성 ${sg(v)}`);
}
function fans(c: Ctx, pct: number) {
  const n = Math.round(c.t.fans * pct / 100);
  c.t.fans = Math.max(0, c.t.fans + n);
  c.lines.push(`팬 ${sg(pct)}% (${n >= 0 ? "+" : ""}${n.toLocaleString("ko-KR")}명)`);
}
function attr(c: Ctx, p: Player, k: AttrKey, v: number) {
  p.attrs[k] = clamp(p.attrs[k] + v, 0, 99);
  c.lines.push(`${nm(p)} ${ATTR_KO[k]} ${sg(v)}`);
}
function pot(c: Ctx, p: Player, v: number) {
  p.pot = clamp(p.pot + v, 0, 99);
  c.lines.push(`${nm(p)}의 성장 가능성이 더 커진 것 같습니다`);
}
function out(c: Ctx, p: Player, days: number, why: NonNullable<Player["outWhy"]>) {
  p.scandal = Math.max(p.scandal ?? 0, days);
  p.outWhy = why;
  for (const r of ROLES) if (c.t.lineup[r] === p.id) {
    c.t.lineup[r] = null;
    // a starter sent to rest or treatment gets his place back when he returns (game.ts scandalDay)
    if (why !== "징계") p.outSlot = r;
  }
  c.lines.push(`${nm(p)} ${days}일 출전 불가 (${why})`);
}
function rest(c: Ctx, p: Player, days: number) {
  p.restDays = Math.max(p.restDays ?? 0, days);
  c.lines.push(`${nm(p)} ${days}일 훈련 대신 휴식`);
}
function aff(c: Ctx, p: Player, v: number) {
  p.affinity = clamp((p.affinity ?? 0) + v, -100, 100);
  c.lines.push(`${nm(p)}의 구단 호감 ${sg(v)}`);
}
function memo(c: Ctx, key: string, tag: string, text: string, other?: string) {
  addMemo(c.s, key, { tag, day: c.s.day, ev: c.def, text, other });
}
function money_(c: Ctx, key: string, v: number) {
  if (v >= 0) earn(c.s, key, v);
  else spend(c.s, key, -v);
  c.lines.push(`자금 ${v >= 0 ? "+" : "-"}${money(Math.abs(v))}`);
}
function quiet(c: Ctx, text: string) {
  c.lines.push(text);
}

/** Schedule an aftermath 3-14 days from now (depth permitting). */
function after(c: Ctx, def: string, pid?: string, other?: string, data?: Record<string, number | string>, due?: number) {
  const depth = c.depth + 1;
  if (depth > MAX_DEPTH) return;
  // time off taken recently halves the chance of turning up late
  if (def === "A5" && pid && hasMemo(c.s, pid, "휴가받음", 30) && c.rng.chance(0.5)) return;
  const day = due ?? c.s.day + c.rng.int(3, 14);
  evState(c.s).queue.push({ def, due: day, until: day + 21, pid, other, depth, data });
}
/** A chance-based aftermath. Burnout is twice as likely after being pushed through pain. */
function maybe(c: Ctx, prob: number, def: string, pid?: string, other?: string, data?: Record<string, number | string>) {
  let pr = prob;
  if (def === "A3" && pid && hasMemo(c.s, pid, "혹사", 30)) pr = Math.min(1, pr * 2);
  if (c.rng.chance(pr)) after(c, def, pid, other, data);
}
function promise(c: Ctx, kind: "starter" | "pay" | "fanmeet" | "rebound" | "raise", pid: string | undefined, due: number, base: number) {
  evState(c.s).promises.push({ kind, pid, due, base, ev: c.def, depth: c.depth });
}

/** Games played over the career, to tell whether a promised start happened. */
const gamesOf = (p: Player) => p.season.g + p.career.g;

function sellAbroad(c: Ctx, p: Player, fee: number, club: string, fansPct: number) {
  const t = c.s.teams[club];
  money_(c, "선수 판매", fee);
  joinTeam(c.s, p, club, salaryAsk(p, c.s.season), 2);
  // stays a regular player abroad, like the LCK players placed at foreign clubs in newGame
  if (p.contract) p.contract.until = 9999;
  addNews(c.s, { kind: "trade", title: `'${p.name}', ${t.name}(${t.region}) 이적`, body: `이적료 ${money(fee)}.`, teams: [c.t.id, club], players: [p.id] });
  c.lines.push(`${nm(p)}가 ${t.name}로 떠났습니다`);
  fans(c, -fansPct);
  syn(c, -5);
}

function letCoachGo(c: Ctx, st: Staff, why: string) {
  releaseStaff(c.s, st);
  addNews(c.s, { kind: "release", title: `${c.t.name} 코치 '${st.name}', ${why}`, teams: [c.t.id] });
  c.lines.push(`${st.name}가 팀을 떠났습니다`);
  syn(c, -2);
}

function owedOf(c: Ctx): { p: Player; amt: number }[] {
  return [...c.t.roster, ...academyOf(c.t)].map((id) => c.s.players[id]).filter((p) => p && p.unpaid > 0)
    .map((p) => ({ p, amt: p.unpaid * Math.round((p.contract?.salary ?? 0) / 12) }));
}
function payOwed(c: Ctx) {
  let paid = 0;
  for (const { p, amt } of owedOf(c).sort((a, b) => a.amt - b.amt)) {
    if (c.t.cash < amt) continue;
    spend(c.s, "밀린 연봉", amt);
    p.unpaid = 0;
    paid += amt;
  }
  c.lines.push(paid ? `밀린 연봉 ${money(paid)} 지급` : "밀린 연봉을 줄 돈이 모자랐습니다");
}

// ---------- scandal topics ----------
export const MILD_SCANDALS = [
  { t: "늦잠으로 팬 행사 지각", body: "늦잠을 자 팬 행사에 한 시간 늦게 도착했습니다." },
  { t: "방송 중 연습 화면 노출", body: "개인 방송 중 팀 연습 화면이 잠깐 비쳤습니다." },
  { t: "인터뷰 말실수로 오해", body: "인터뷰에서 한 농담이 상대 팀을 깎아내린 것처럼 퍼졌습니다." },
  { t: "방송 중 과격한 리액션", body: "개인 방송에서 패배 뒤 책상을 내리치는 장면이 퍼졌습니다." },
];
export const SERIOUS_SCANDALS = [
  { t: "솔로랭크 대리 게임 의혹", days: 60, body: "다른 사람 계정을 대신 올려 준 정황이 드러났습니다." },
  { t: "방송 중 비하 발언 논란", days: 14, body: "개인 방송에서 부적절한 발언을 해 사과문을 올렸습니다." },
  { t: "솔로랭크 고의 트롤 의혹", days: 21, body: "랭크 게임에서 고의로 패배를 유도했다는 신고가 이어졌습니다." },
  { t: "불법 프로그램 사용 의혹", days: 90, body: "연습 계정에서 금지 프로그램 사용 흔적이 나왔습니다." },
];
export const FICTION = " (게임 속 가상 사건)";

// ---------- event definitions ----------
const DEFS: Def[] = [];
const def = (d: Def) => DEFS.push(d);

// ===== random, negative =====
def({
  id: "N1", pol: "neg", cls: "random",
  find: (c) => {
    const sr = lastSeries(c.s);
    if (!sr || sr.winner === c.s.user || c.s.day - sr.day > 2) return 0;
    const deaths = new Map<string, number>();
    for (const g of sr.games) for (const [pid, b] of Object.entries(g.box ?? {})) if (c.s.players[pid]?.team === c.s.user) deaths.set(pid, (deaths.get(pid) ?? 0) + b.d);
    const worst = topBy(c, [...deaths.entries()], (x) => x[1]);
    const p = worst ? c.s.players[worst[0]] : null;
    if (!p || p.fame < 40 || !cdOk(c, `N1:${p.id}`, 60)) return 0;
    c.p = p;
    return 3;
  },
  title: () => "악플 테러",
  body: (c) => `${nm(c.p!)}의 SNS에 패배 책임을 묻는 댓글이 수천 개 달렸습니다.`,
  opts: (c) => {
    const p = c.p!;
    const half = hasMemo(c.s, p.id, "악플견딤") ? 0.5 : 1;
    const loss = (v: number) => Math.round(v * half);
    return [
      { label: "SNS를 잠시 쉬게 합니다", rolls: [[
        { p: 0.7, hint: "마음이 편해질", fx: (c) => mo(c, p, 8) },
        { p: 0.3, hint: "팬들이 서운해할", fx: (c) => { mo(c, p, 3); fans(c, -1); } },
      ]] },
      { label: "구단이 법적 대응합니다", cost: 4000, hint: "선수가 든든해할", always: (c) => mo(c, p, 12), rolls: [
        [{ p: 0.6, hint: "구단 평판이 오를", fx: (c) => tfame(c, 1) }],
        [{ p: 0.2, hint: "일이 커질", fx: (c) => fans(c, -2) }],
      ] },
      { label: "신경 쓰지 말라고 합니다", rolls: [[
        { p: 0.5, hint: "털어 낼", fx: (c) => {
          mo(c, p, loss(-3));
          memo(c, p.id, "악플견딤", "악플을 털어 냄");
          if (countMemo(c.s, p.id, "악플견딤") >= 2 && !hasMemo(c.s, p.id, "멘탈성장")) { memo(c, p.id, "멘탈성장", "악플을 두 번 이겨 냄"); after(c, "A10", p.id); }
        } },
        { p: 0.5, hint: "오래 남을", fx: (c) => { mo(c, p, loss(-10)); maybe(c, 0.4, "A4", p.id); } },
      ]] },
    ];
  },
});

def({
  id: "N2", pol: "neg", cls: "random",
  find: (c) => {
    const hard = (c.t.trainPlan?.intensity ?? "normal") === "hard";
    // 65, not the design's 70: auto rest starts at 65 by default, so 70 was almost never reached
    const xs = roster(c).filter((p) => !p.scandal && (p.fatigue >= 65 || (hard && p.fatigue >= 55)) && cdOk(c, `N2:${p.id}`, 60));
    const p = pickOne(c, xs, weightStar(c));
    if (!p) return 0;
    c.p = p;
    return 3;
  },
  title: () => "손목 통증",
  body: (c) => `${nm(c.p!)}가 연습 도중 손목을 주무르며 통증을 호소합니다.`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "3일 완전 휴식", hint: "금방 나을", always: (c) => { out(c, p, 3, "휴식"); fat(c, p, -40); }, rolls: [[{ p: 0.5, hint: "감을 잃을", fx: (c) => form(c, p, -1) }]] },
      { label: "정밀 검진", cost: 2500, rolls: [[
        { p: 0.8, hint: "별일 아닐", fx: (c) => { fat(c, p, -15); mo(c, p, 5); } },
        { p: 0.2, hint: "뭔가 나올", fx: (c) => out(c, p, 5, "부상") },
      ]] },
      { label: "참고 출전합니다", rolls: [[
        { p: 0.55, hint: "버틸", fx: (c) => quiet(c, `${nm(p)}가 별일 없이 버텼습니다`) },
        { p: 0.3, hint: "악화될", fx: (c) => { out(c, p, 7, "부상"); mo(c, p, -10); } },
        { p: 0.15, fx: (c) => { memo(c, p.id, "혹사", "통증을 참고 뜀"); after(c, "A3", p.id); quiet(c, `${nm(p)}가 많이 지쳐 보입니다`); } },
      ]] },
    ];
  },
});

def({
  id: "N3", pol: "neg", cls: "random",
  find: (c) => {
    const sr = nextSeries(c.s);
    if (!sr || sr.day - c.s.day > 2 || !bigSeries(sr)) return 0;
    const xs = starters(c).filter((p) => (p.morale < 60 || age(p, c.s.season) <= 20) && cdOk(c, `N3:${p.id}`, 60));
    const p = pickOne(c, xs);
    if (!p) return 0;
    c.p = p;
    return 3;
  },
  title: () => "큰 경기 전 불면",
  body: (c) => `${nm(c.p!)}가 큰 경기를 앞두고 며칠째 잠을 못 이루고 있습니다.`,
  opts: (c) => {
    const p = c.p!;
    const pt = clamp((0.4 + motivate(c) * 0.004) * trust(c, p), 0.05, 0.9);
    return [
      { label: "수면 클리닉", cost: 1200, hint: "푹 잘", always: (c) => fat(c, p, -15), rolls: [[{ p: 0.7, hint: "컨디션이 오를", fx: (c) => form(c, p, 1) }]] },
      { label: "감독 면담", rolls: [[
        { p: pt, hint: "마음을 다잡을", fx: (c) => mo(c, p, 10) },
        { p: 1 - pt, hint: "오히려 부담될", fx: (c) => mo(c, p, -3) },
      ]] },
      { label: "평소대로 둡니다", rolls: [[
        { p: 0.5, hint: "경기에 영향이 갈", fx: (c) => form(c, p, -2) },
        { p: 0.3, hint: "괜찮을", fx: (c) => quiet(c, `${nm(p)}가 무난하게 컨디션을 되찾았습니다`) },
        { p: 0.2, hidden: true, fx: (c) => form(c, p, 2) },
      ]] },
    ];
  },
});

def({
  id: "N5", pol: "neg", cls: "random",
  find: (c) => {
    const pairs: [Role, Role][] = [["Mid", "Jungle"], ["Bot", "Support"]];
    const ok = pairs.map(([a, b]) => [c.t.lineup[a], c.t.lineup[b]] as const).filter(([a, b]) => a && b && cdOk(c, `N5:${a}:${b}`, 60));
    const pair = pickOne(c, ok);
    if (!pair) return 0;
    c.p = c.s.players[pair[0]!];
    c.q = c.s.players[pair[1]!];
    const bench = roster(c).find((x) => x.role === c.p!.role && !isStarter(c, x) && !x.scandal);
    if (bench) c.d.bench = bench.id;
    c.d.cdKey = `N5:${pair[0]}:${pair[1]}`;
    return 1;
  },
  title: () => "라인 콜 충돌",
  body: (c) => `${nm(c.p!)}와 ${nm(c.q!)}가 교전 콜을 두고 연습 중에 계속 엇갈립니다.`,
  opts: (c) => {
    const p = c.p!, q = c.q!;
    const pc = clamp(0.5 + bestAnalysis(c) * 0.004, 0.05, 0.9);
    const bench = c.d.bench ? c.s.players[c.d.bench as string] : null;
    return [
      { label: "둘이 따로 합을 맞춥니다", hint: "둘 다 지칠", always: (c) => { fat(c, p, 10); fat(c, q, 10); }, rolls: [[{ p: 0.7, hint: "호흡이 좋아질", fx: (c) => syn(c, 3) }]] },
      { label: "코치가 콜 정리", avail: staffOf(c).length > 0, rolls: [[{ p: pc, hint: "깔끔해질", fx: (c) => { syn(c, 2); mo(c, p, 3); mo(c, q, 3); } }]] },
      { label: bench ? `${nm(p)} 교체를 검토합니다` : "교체를 검토합니다 (같은 포지션 후보가 없음)", avail: !!bench, hint: "긴장할",
        always: (c) => { mo(c, p, -8); if (bench) mo(c, bench, 8); }, rolls: [[{ p: 0.3, hint: "반발할", fx: (c) => after(c, "A1", p.id) }]] },
    ];
  },
});

def({
  id: "N7", pol: "neg", cls: "random",
  find: (c) => {
    if (c.d.staff) return !!c.s.staff[c.d.staff as string] && c.s.staff[c.d.staff as string].team === c.s.user;
    const xs = staffOf(c).filter((x) => (x.fame >= 50 || x.titles >= 1) && cdOk(c, `N7:${x.id}`, 60));
    const st = pickOne(c, xs);
    if (!st) return 0;
    c.d.staff = st.id;
    c.d.cdKey = `N7:${st.id}`;
    return 1;
  },
  title: () => "코치에게 들어온 제의",
  body: (c) => `${c.s.staff[c.d.staff as string].name}에게 다른 구단이 더 좋은 조건을 제시했다는 소식입니다.`,
  opts: (c) => {
    const st = c.s.staff[c.d.staff as string];
    const raise = Math.round(((st?.contract?.salary ?? 0) * 0.2) / 100) * 100;
    return [
      { label: `연봉 20% 인상 (연 +${money(raise)})`, rolls: [[
        { p: 0.9, hint: "남을", fx: (c) => { if (st.contract) st.contract.salary += raise; quiet(c, `${st.name} 연봉 ${money(st.contract?.salary ?? 0)}로 인상, 잔류`); } },
        { p: 0.1, fx: (c) => letCoachGo(c, st, "다른 구단행") },
      ]] },
      { label: "설득합니다", rolls: [[
        { p: 0.5, hint: "남을", fx: (c) => quiet(c, `${st.name}가 남기로 했습니다`) },
        { p: 0.5, hint: "떠날", fx: (c) => letCoachGo(c, st, "다른 구단행") },
      ]] },
      { label: "축하하고 보내 줍니다", hint: "좋게 헤어질", always: (c) => { letCoachGo(c, st, "좋게 이별"); tfame(c, 1); } },
    ];
  },
});

def({
  id: "N8", pol: "neg", cls: "random",
  find: (c) => {
    const xs = roster(c).filter((p) => p.contract && p.contract.until <= c.s.season && p.persona.ambition >= 0.6 && (p.affinity ?? 0) < 20 && cdOk(c, `N8:${p.id}`, 60));
    const p = pickOne(c, xs, weightStar(c));
    if (!p) return 0;
    c.p = p;
    return 1;
  },
  title: () => "타 팀 접촉 소문",
  body: (c) => `${nm(c.p!)}가 다른 구단과 연락을 주고받는다는 소문이 돕니다. 계약은 이번 시즌까지입니다.`,
  opts: (c) => {
    const p = c.p!;
    const pt = 0.5 * trust(c, p);
    return [
      { label: "조기 재계약 제안", hint: "요구액이 조금 오를", note: "선택하면 바로 재계약 협상을 엽니다.",
        always: (c) => { memo(c, p.id, "조기재계약", "조기 재계약 제안을 받음"); quiet(c, "재계약 협상을 엽니다 (요구액 +5%)"); evState(c.s).result = { title: "", lines: [], open: { pid: p.id, mode: "renew" } }; } },
      { label: "1:1 면담", rolls: [[{ p: pt, hint: "마음이 돌아올", fx: (c) => aff(c, p, 15) }]] },
      { label: "모른 척합니다", rolls: [[
        { p: 0.6, hint: "소문으로 끝날", fx: (c) => quiet(c, "소문은 잠잠해졌습니다") },
        { p: 0.4, hint: "떠날 마음을 굳힐", fx: (c) => after(c, "A6", p.id, undefined, undefined, nextWindowDay(c.s)) },
      ]] },
    ];
  },
});

/** The first day the transfer window is open from now (a week from now if it is open already). */
function nextWindowDay(s: GameState): number {
  for (let d = s.day + 3; d < s.day + 200; d++) {
    const probe = { ...s, day: d } as GameState;
    if (windowOpen(probe)) return d;
  }
  return s.day + 7;
}

def({
  id: "N9", pol: "neg", cls: "random",
  find: (c) => {
    if (!windowOpen(c.s) || !c.s.intl.length) return 0;
    // the team's two best by ability, famous or not (was: fame 60+ too, which on most teams left one star alone);
    // a famous target keeps the special-event weight
    const top = c.rng.shuffle(roster(c)).sort((a, b) => ovr(b) - ovr(a)).slice(0, 2).filter((p) => p.contract && cdOk(c, `N9:${p.id}`, 60));
    const p = pickOne(c, top);
    if (!p) return 0;
    c.p = p;
    c.d.fee = Math.round((marketValue(p, c.s.season) * 1.3) / 100) * 100;
    c.d.club = c.rng.pick(c.s.intl);
    return p.fame >= 60 ? 3 : 1;
  },
  title: () => "해외 구단의 거액 제안",
  body: (c) => `${teamName(c.s, c.d.club as string)}(${c.s.teams[c.d.club as string].region})가 ${nm(c.p!)} 영입에 이적료 ${money(c.d.fee as number)}을 제시했습니다.`,
  opts: (c) => {
    const p = c.p!;
    const fee = c.d.fee as number, club = c.d.club as string;
    const stay = clamp(0.3 + p.persona.loyalty * 0.5, 0.05, 0.95);
    return [
      { label: `판매합니다 (+${money(fee)})`, hint: "팬이 실망할", always: (c) => sellAbroad(c, p, fee, club, 3) },
      { label: "거절합니다", rolls: [[
        { p: stay, hint: "남은 걸 기뻐할", fx: (c) => { aff(c, p, 20); mo(c, p, 5); } },
        { p: 1 - stay, hint: "아쉬워할", fx: (c) => { mo(c, p, -10); maybe(c, 0.5, "A2", p.id); } },
      ]] },
      { label: "선수에게 맡깁니다", rolls: [[
        { p: stay, hint: "남을", fx: (c) => mo(c, p, 10) },
        { p: 1 - stay, hint: "떠날", fx: (c) => sellAbroad(c, p, fee, club, 1) },
      ]] },
    ];
  },
});

const FAC_KO: Record<keyof Team["facilities"], string> = { training: "훈련 시설", housing: "숙소", analysis: "분석실", marketing: "마케팅" };

def({
  id: "N10", pol: "neg", cls: "random", team: true,
  find: (c) => {
    const owed = owedOf(c);
    if (owed.length < 2 || !cdOk(c, "N10", 30)) return 0;
    const most = topBy(c, owed, (x) => x.p.unpaid);
    if (!most) return 0;
    c.p = most.p;
    return 3;
  },
  title: () => "연봉 체불 항의",
  body: (c) => `급여가 밀린 선수들이 ${nm(c.p!)}를 앞세워 단장실을 찾아왔습니다. 밀린 연봉은 모두 ${money(owedOf(c).reduce((a, x) => a + x.amt, 0))}입니다.`,
  opts: (c) => {
    const top = (Object.keys(c.t.facilities) as (keyof Team["facilities"])[]).sort((a, b) => c.t.facilities[b] - c.t.facilities[a])[0];
    const lv = c.t.facilities[top];
    const value = Math.round(facilityCost(lv - 1) * 0.6);
    return [
      { label: "7일 안에 지급 약속", hint: "믿어 줄", note: "7일 뒤에도 밀려 있으면 크게 실망할 거예요.",
        always: (c) => { moList(c, roster(c), 5, "선수단 전원"); promise(c, "pay", undefined, c.s.day + 7, 0); } },
      { label: lv > 0 ? `${FAC_KO[top]}을 팔아 지급 (+${money(value)})` : "시설을 팔아 지급 (팔 시설이 없음)", avail: lv > 0, hint: "급한 불을 끌",
        always: (c) => { c.t.facilities[top] = lv - 1; money_(c, "시설 매각", value); quiet(c, `${FAC_KO[top]} 레벨 ${lv} → ${lv - 1}`); payOwed(c); moList(c, roster(c), 3, "선수단 전원"); } },
      { label: "사과만 합니다", always: (c) => moList(c, roster(c), -8, "선수단 전원"), rolls: [[
        { p: 0.7, hint: "참아 줄", fx: (c) => quiet(c, "선수들이 일단 참기로 했습니다") },
        { p: 0.3, hint: "들고일어날", fx: (c) => after(c, "A7") },
      ]] },
    ];
  },
});

def({
  id: "N11", pol: "neg", cls: "random", team: true,
  find: (c) => (c.t.facilities.housing <= 1 && roster(c).length >= 5 && cdOk(c, "N11", 30) ? 1 : 0),
  title: () => "숙소 시설 고장",
  body: () => "숙소 보일러와 인터넷이 동시에 고장 났습니다. 수리에 며칠은 걸린다고 합니다.",
  opts: () => [
    { label: "즉시 수리", cost: 6000, always: (c) => quiet(c, "바로 고쳤습니다") },
    { label: "임시 숙소로 이동", cost: 2000, rolls: [[{ p: 0.6, hint: "불편할", fx: (c) => fatList(c, roster(c), 10, "선수단 전원") }]] },
    { label: "버팁니다", rolls: [[
      { p: 0.6, hint: "다들 지칠", fx: (c) => { moList(c, roster(c), -5, "선수단 전원"); fatList(c, roster(c), 15, "선수단 전원"); } },
      { p: 0.4, hint: "버틸 만할", fx: (c) => quiet(c, "생각보다 금방 고쳐졌습니다") },
    ]] },
  ],
});

def({
  id: "N12", pol: "neg", cls: "random", matchDay: true,
  find: (c) => {
    const p = pickOne(c, starters(c).filter((x) => cdOk(c, `N12:${x.id}`, 60)));
    if (!p) return 0;
    c.p = p;
    return 1;
  },
  title: () => "경기 직전 장비 고장",
  body: (c) => `경기장에 도착하자 ${nm(c.p!)}의 마우스가 말을 듣지 않습니다.`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "예비 장비 사용", rolls: [[{ p: 0.3, hint: "손에 안 맞을", fx: (c) => form(c, p, -1) }]] },
      { label: "급히 새로 구매", cost: 800, always: (c) => quiet(c, "같은 모델을 구해 왔습니다") },
      { label: "개인 장비 고집 허락", rolls: [[
        { p: 0.7, hint: "편할", fx: (c) => mo(c, p, 3) },
        { p: 0.3, hint: "문제가 다시 생길", fx: (c) => form(c, p, -2) },
      ]] },
    ];
  },
});

def({
  id: "N13", pol: "neg", cls: "random", team: true, matchDay: true,
  find: (c) => {
    const sr = userSeriesOn(c.s, c.s.day);
    if (!sr || !bigSeries(sr) || !cdOk(c, "N13", 30)) return 0;
    c.d.sr = sr.id;
    c.d.opp = oppOf(c.s, sr);
    return 3;
  },
  title: () => "상대의 도발 인터뷰",
  body: (c) => `${teamName(c.s, c.d.opp as string)} 선수가 사전 인터뷰에서 "이번엔 쉽게 이길 것 같다"고 말했습니다.`,
  opts: (c) => [
    { label: "맞받아칩니다", hint: "판이 커질", note: "이기면 크게 오르고, 지면 크게 흔들릴 거예요.",
      always: (c) => { fans(c, 2); memo(c, "team", "도발", "상대 도발에 맞받아침", c.d.sr as string); } },
    { label: "무시합니다", always: (c) => quiet(c, "조용히 경기를 준비합니다") },
    { label: "정중하게 응수", rolls: [[{ p: 0.5, hint: "품격을 보여 줄", fx: (c) => tfame(c, 1) }]] },
  ],
});

def({
  id: "N14", pol: "neg", cls: "random",
  find: (c) => {
    const m = c.s.meta;
    if (!m || c.s.day - m.since > 2 || !c.data) return 0;
    const nerf = new Set(m.history.at(-1)?.nerf ?? []);
    const hit = starters(c).filter((p) => cdOk(c, `N14:${p.id}`, 60)).map((p) => {
      const top = Object.entries(p.mastery).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
      return { p, champ: top.find((id) => nerf.has(id)) };
    }).filter((x) => x.champ);
    const h = pickOne(c, hit);
    if (!h) return 0;
    const sPool = Object.entries(m.tiers).filter(([id, t]) => t === "S" && (c.data!.champ.get(id)?.roles[h.p.role] ?? 0) >= 0.35).map(([id]) => id);
    if (!sPool.length) return 0;
    c.p = h.p;
    c.d.champ = h.champ!;
    c.d.sChamp = sPool.sort((a, b) => (h.p.mastery[b] ?? 0) - (h.p.mastery[a] ?? 0))[0];
    // names kept with the event: the champion data is not at hand when the choice is resolved
    c.d.champName = c.data.champ.get(c.d.champ as string)?.name ?? (c.d.champ as string);
    c.d.sName = c.data.champ.get(c.d.sChamp as string)?.name ?? (c.d.sChamp as string);
    return 3;
  },
  title: () => "메타 급변 패치",
  body: (c) => `새 패치에서 ${nm(c.p!)}의 주력 챔피언 ${champName(c, c.d.champ as string)}가 너프됐습니다. ${champName(c, c.d.sChamp as string)}가 새로 떠올랐습니다.`,
  opts: (c) => {
    const p = c.p!;
    const sc = c.d.sChamp as string;
    const learn = (v: number) => (c: Ctx) => { p.mastery[sc] = clamp((p.mastery[sc] ?? 35) + v, 0, 100); c.lines.push(`${nm(p)} ${champName(c, sc)} 숙련도 +${v}`); memo(c, p.id, `챔프:${sc}`, `${champName(c, sc)} 집중 연습`); };
    return [
      { label: "새 메타 집중 연습", hint: "지칠", always: (c) => { fat(c, p, 10); mo(c, p, -3); }, rolls: [[{ p: 0.7, hint: "빨리 적응할", fx: learn(8) }]] },
      { label: "주력 챔피언 유지", hint: "밀고 나갈", always: (c) => mo(c, p, 3), rolls: [[{ p: 0.3, hint: "뒤처질", fx: (c) => form(c, p, -1) }]] },
      { label: "분석관 투입", avail: staffOf(c).some((x) => x.role === "Analyst"), rolls: [[{ p: 0.9, hint: "답을 찾을", fx: learn(5) }]] },
    ];
  },
});
const champName = (c: Ctx, id: string) =>
  c.data?.champ.get(id)?.name ?? (id === c.d.sChamp ? (c.d.sName as string) : id === c.d.champ ? (c.d.champName as string) : undefined) ?? id;

def({
  id: "N16", pol: "neg", cls: "random", team: true,
  find: (c) => {
    const sr = lastSeries(c.s);
    if (!sr || sr.winner === c.s.user || c.s.day - sr.day > 1 || !sr.games.length || sr.games[0].winner !== c.s.user || !cdOk(c, "N16", 30)) return 0;
    return 3;
  },
  title: () => "역전패 뒤 분위기 침체",
  body: () => "첫 세트를 따고도 역전패하자 숙소에 말소리가 사라졌습니다.",
  opts: () => [
    { label: "회식", cost: 1500, rolls: [[{ p: 0.6, hint: "털고 일어날", fx: (c) => moList(c, starters(c), 6, "주전") }]] },
    { label: "하루 휴식", hint: "쉬면 나아질", always: (c) => { fatList(c, roster(c), -20, "선수단 전원"); syn(c, -1); } },
    { label: "다음 경기만 생각하자", rolls: [[
      { p: 0.5, hint: "오기가 생길", fx: (c) => { for (const p of starters(c)) p.form = clamp(p.form + 1, -10, 10); c.lines.push("주전 폼 +1"); } },
      { p: 0.5, hint: "가라앉을", fx: (c) => moList(c, starters(c), -5, "주전") },
    ]] },
  ],
});

def({
  id: "N17", pol: "neg", cls: "random",
  find: (c) => {
    const xs = roster(c).filter((p) => p.nat !== "KR" && p.contract && c.s.day - p.contract.signedDay >= 30 && cdOk(c, `N17:${p.id}`, 60));
    const p = pickOne(c, xs, weightStar(c));
    if (!p) return 0;
    c.p = p;
    return 1;
  },
  title: () => "향수병",
  body: (c) => `${nm(c.p!)}가 고향과 가족이 그립다며 부쩍 말수가 줄었습니다.`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "가족 초청", cost: 2500, hint: "큰 힘이 될", always: (c) => mo(c, p, 15) },
      { label: "1주 귀국 휴가", hint: "돌아오면 더 좋아질", always: (c) => { out(c, p, 7, "휴가"); mo(c, p, 20); fat(c, p, -40); memo(c, p.id, "휴가받음", "귀국 휴가를 받음"); } },
      { label: "조금만 참아 달라", always: (c) => mo(c, p, -10), rolls: [[{ p: 0.3, hint: "떠날 생각을 할", fx: (c) => after(c, "A6", p.id) }]] },
    ];
  },
});

def({
  id: "N18", pol: "neg", cls: "random",
  find: (c) => {
    const xs = roster(c).filter((p) => age(p, c.s.season) >= 28 && !p.retireAfter && (p.form <= -2 || !isStarter(c, p))
      && !(p.name === "Faker" && age(p, c.s.season) < 35) && cdOk(c, `N18:${p.id}`, 60));
    const p = pickOne(c, xs, weightStar(c));
    if (!p) return 0;
    c.p = p;
    return 1;
  },
  title: () => "베테랑의 은퇴 고민",
  body: (c) => `${nm(c.p!)}: "요즘 손이 예전 같지 않습니다. 이번 시즌이 마지막일지도 모르겠어요."`,
  opts: (c) => {
    const p = c.p!;
    const pt = 0.6 * trust(c, p);
    return [
      { label: "설득합니다", rolls: [[
        { p: pt, hint: "다시 불태울", fx: (c) => mo(c, p, 10) },
        { p: 1 - pt, hint: "마음이 굳어 있을", fx: (c) => { p.retireAfter = true; quiet(c, `${nm(p)}는 시즌이 끝나면 은퇴합니다`); } },
      ]] },
      { label: "결정을 존중합니다", hint: "아름답게 떠날", always: (c) => { p.retireAfter = true; quiet(c, `${nm(p)}는 시즌이 끝나면 은퇴합니다`); tfame(c, 2); mo(c, p, 10); } },
    ];
  },
});

def({
  id: "N20", pol: "neg", cls: "random",
  find: (c) => {
    const xs = roster(c).filter((p) => !p.scandal && cdOk(c, `N20:${p.id}`, 60));
    const p = pickOne(c, xs, (x) => (0.5 + x.persona.temper) * weightStar(c)(x));
    if (!p) return 0;
    c.p = p;
    c.d.tier = c.rng.chance(0.3) ? "serious" : "mild";
    c.d.k = c.rng.int(0, (c.d.tier === "serious" ? SERIOUS_SCANDALS : MILD_SCANDALS).length - 1);
    return 1;
  },
  title: (c) => (c.d.tier === "serious" ? SERIOUS_SCANDALS : MILD_SCANDALS)[c.d.k as number].t,
  body: (c) => `${nm(c.p!)}: ${(c.d.tier === "serious" ? SERIOUS_SCANDALS : MILD_SCANDALS)[c.d.k as number].body}${FICTION}`,
  opts: (c) => {
    const p = c.p!;
    const covered = hasMemo(c.s, p.id, "감싸줌");
    const cover = (c: Ctx) => { memo(c, p.id, "감싸줌", `논란 때 구단이 감싸 줌${FICTION}`); maybe(c, 0.3, "A9", p.id, undefined, { why: "cover" }); };
    if (c.d.tier !== "serious") {
      return [
        { label: "공개 사과", hint: "선수가 위축될", always: (c) => mo(c, p, -5), rolls: [[
          { p: 0.7, hint: "금방 잊힐", fx: (c) => quiet(c, "금방 잠잠해졌습니다") },
          { p: 0.3, hint: "팬이 조금 줄", fx: (c) => fans(c, -1) },
        ]] },
        { label: "내부 경고만", always: (c) => mo(c, p, -2), rolls: [[
          { p: 0.7, hint: "조용히 지나갈", fx: (c) => quiet(c, "조용히 지나갔습니다") },
          { p: 0.3, hint: "말이 퍼질", fx: (c) => fans(c, -2) },
        ]] },
        { label: "감싸 줍니다", hint: "선수가 고마워할", always: (c) => { mo(c, p, 5); cover(c); },
          rolls: [[{ p: covered ? 1 : 0.5, hint: "팬들이 실망할", fx: (c) => { tfame(c, -2); fans(c, -2); } }]] },
      ];
    }
    return [
      { label: "출전 정지와 벌금 (21일 출전 불가)", hint: "선수가 크게 흔들릴", always: (c) => { out(c, p, 21, "징계"); mo(c, p, -20); },
        rolls: [[{ p: 0.7, hint: "여론이 가라앉을", fx: (c) => tfame(c, 1) }]] },
      { label: "감싸 줍니다", hint: "팬이 크게 등을 돌릴", always: (c) => { mo(c, p, 5); tfame(c, -5); fans(c, -3); cover(c); },
        rolls: [[{ p: covered ? 0.8 : 0.4, hint: "논란이 더 커질", fx: (c) => after(c, "A8", p.id) }]] },
      { label: "계약 해지", hint: "단호해 보일", always: (c) => { releasePlayer(c.s, p, "품위 손상"); autoLineupUser(c); c.lines.push(`${nm(p)} 방출`); tfame(c, 2); } },
    ];
  },
});

/** After a user player leaves: fill holes only, keeping the user's choices. */
function autoLineupUser(c: Ctx) {
  const t = c.t;
  for (const r of ROLES) {
    if (t.lineup[r] && t.roster.includes(t.lineup[r]!)) continue;
    const used = new Set(Object.values(t.lineup).filter(Boolean));
    const free = t.roster.map((id) => c.s.players[id]).filter((p) => p && !p.scandal && !used.has(p.id));
    const best = free.filter((p) => p.role === r).sort((a, b) => ovr(b) - ovr(a))[0] ?? free.sort((a, b) => ovr(b) - ovr(a))[0];
    t.lineup[r] = best?.id ?? null;
  }
}

def({
  id: "N21", pol: "neg", cls: "random",
  find: (c) => {
    const xs = academyOf(c.t).map((id) => c.s.players[id]).filter((p) => {
      if (!p || p.scandal || !cdOk(c, `N21:${p.id}`, 60)) return false;
      const st = c.t.lineup[p.role] ? c.s.players[c.t.lineup[p.role]!] : null;
      return !!st && ovr(p) >= ovr(st) - 2;
    });
    const p = pickOne(c, xs);
    if (!p) return 0;
    c.p = p;
    c.q = c.s.players[c.t.lineup[p.role]!];
    return 3;
  },
  title: () => "2군 선수의 콜업 요구",
  body: (c) => `2군 ${nm(c.p!)}: "${nm(c.q!)} 선배만큼은 할 수 있습니다. 1군에서 뛰게 해 주세요."`,
  opts: (c) => {
    const p = c.p!, q = c.q!;
    const can = canCallUp(c.s, p);
    return [
      { label: can.ok ? "1군으로 올립니다" : `1군으로 올립니다 (${can.msg ?? "불가"})`, avail: can.ok, hint: "기회를 잡을",
        always: (c) => {
          // callUp adds its own +10; the event's +15 replaces it so the result line tells the whole change
          const m0 = p.morale;
          callUp(c.s, p);
          p.morale = m0;
          c.lines.push(`${nm(p)} 1군 콜업`);
          mo(c, p, 15);
          mo(c, q, -10);
        }, rolls: [[{ p: 0.4, hint: "주전이 흔들릴", fx: (c) => after(c, "A1", q.id) }]] },
      { label: "2주 안에 기회를 약속", hint: "기다려 줄", note: "2주 안에 한 경기도 못 뛰면 크게 실망할 거예요.",
        always: (c) => { mo(c, p, 5); promise(c, "starter", p.id, c.s.day + 14, gamesOf(p)); memo(c, p.id, "약속:주전", "2주 안 출전 약속을 받음"); } },
      { label: "기다리라고 합니다", always: (c) => mo(c, p, -10), rolls: [[
        { p: 0.3, hint: "이를 악물", fx: (c) => attr(c, p, "mechanics", 1) },
        { p: 0.3, hint: "떠날", fx: (c) => after(c, "A6", p.id) },
      ]] },
    ];
  },
});

def({
  id: "N22", pol: "neg", cls: "random", team: true,
  find: (c) => (c.s.trophies.some((x) => c.s.day - x.day <= 7 && x.comp !== "REG") && cdOk(c, "N22", 30) && roster(c).length ? 3 : 0),
  title: () => "우승 뒤 해이",
  body: () => "우승 뒤 연습 분위기가 눈에 띄게 느슨해졌습니다.",
  opts: () => [
    { label: "3일 휴가", hint: "재충전될", always: (c) => { for (const p of roster(c)) { p.restDays = Math.max(p.restDays ?? 0, 3); memo(c, p.id, "휴가받음", "우승 휴가"); } c.lines.push("선수단 전원 3일 휴식"); fatList(c, roster(c), -30, "선수단 전원"); },
      rolls: [[{ p: 0.5, hint: "감이 떨어질", fx: (c) => syn(c, -2) }]] },
    { label: "바로 다잡습니다", hint: "불만이 생길", always: (c) => moList(c, roster(c), -5, "선수단 전원"), rolls: [[{ p: 0.5, hint: "긴장이 이어질", fx: (c) => syn(c, 3) }]] },
    { label: "축하 파티", cost: 2500, hint: "즐거울", always: (c) => moList(c, roster(c), 8, "선수단 전원"),
      rolls: [[{ p: 0.3, hint: "들뜰", fx: (c) => { const p = pickOne(c, roster(c)); if (p) after(c, "A5", p.id); } }]] },
  ],
});

def({
  id: "N23", pol: "neg", cls: "random", team: true,
  find: (c) => {
    const sr = nextSeries(c.s);
    return sr && (sr.comp === "REG" || sr.comp === "REG2") && cdOk(c, "N23", 30) ? 1 : 0;
  },
  title: () => "스크림 전략 유출 의심",
  body: () => "스크림에서만 쓴 전략을 다른 팀이 경기에서 그대로 들고 나왔습니다.",
  opts: () => [
    { label: "스크림 상대를 바꿉니다", hint: "안전해질", always: (c) => syn(c, -1) },
    { label: "역정보를 흘립니다", rolls: [[
      { p: 0.5, hint: "상대를 속일", fx: (c) => moList(c, starters(c), 8, "주전") },
      { p: 0.3, hidden: true, fx: (c) => { quiet(c, "역정보를 흘린 게 들통났습니다"); tfame(c, -2); } },
      { p: 0.2, fx: (c) => quiet(c, "별 효과가 없었습니다") },
    ]] },
    { label: "넘어갑니다", rolls: [[{ p: 0.4, hint: "선수들이 불안해할", fx: (c) => moList(c, starters(c), -4, "주전") }]] },
  ],
});

def({
  id: "N24", pol: "neg", cls: "random",
  find: (c) => {
    const xs = roster(c).filter((p) => p.form >= 5 && p.contract && p.contract.salary < salaryAsk(p, c.s.season) * 0.8 && cdOk(c, `N24:${p.id}`, 60));
    const p = pickOne(c, xs, weightStar(c));
    if (!p) return 0;
    c.p = p;
    return 3;
  },
  title: () => "에이전트의 연봉 재협상 요구",
  body: (c) => `${nm(c.p!)}의 에이전트가 찾아왔습니다. "요즘 활약을 보면 지금 연봉은 너무 적습니다."`,
  opts: (c) => {
    const p = c.p!;
    const raise = Math.round(((p.contract?.salary ?? 0) * 0.1) / 100) * 100;
    const due = seasonDates(c.s.season).end + 30;
    return [
      { label: `이번 시즌 연봉 10% 인상 (연 +${money(raise)})`, hint: "만족할", always: (c) => { if (p.contract) p.contract.salary += raise; quiet(c, `${nm(p)} 연봉 ${money(p.contract?.salary ?? 0)}`); mo(c, p, 10); aff(c, p, 10); } },
      { label: "시즌 뒤 재협상 약속", hint: "기다려 줄", note: "시즌 뒤 대우가 오르지 않으면 크게 실망할 거예요.",
        always: (c) => { mo(c, p, 4); promise(c, "raise", p.id, due, p.contract?.salary ?? 0); memo(c, p.id, "약속:재협상", "시즌 뒤 연봉 재협상 약속"); } },
      { label: "계약은 계약입니다", rolls: [[
        { p: 0.5, hint: "받아들일", fx: (c) => mo(c, p, -6) },
        { p: 0.5, hint: "서운해할", fx: (c) => after(c, "A2", p.id) },
      ]] },
    ];
  },
});

// ===== random, positive =====
def({
  id: "P1", pol: "pos", cls: "random",
  find: (c) => {
    const st = starters(c);
    // in form, or among the team's two best mechanics (was: the single best, every time); ties at the cut all count
    const cut = [...st].map((p) => p.attrs.mechanics).sort((a, b) => b - a)[1] ?? -Infinity;
    const xs = st.filter((p) => (p.form >= 3 || p.attrs.mechanics >= cut) && cdOk(c, `P1:${p.id}`, 60));
    const p = pickOne(c, xs);
    if (!p) return 0;
    c.p = p;
    return 1;
  },
  title: () => "솔로랭크 1위 달성",
  body: (c) => `${nm(c.p!)}가 한국 서버 솔로랭크 1위에 올랐습니다.`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "방송으로 자축", rolls: [[{ p: 0.7, hint: "팬이 늘", fx: (c) => fans(c, 2) }], [{ p: 0.3, hint: "피곤할", fx: (c) => fat(c, p, 10) }]] },
      { label: "조용히 넘어갑니다", hint: "기분 좋게 넘길", always: (c) => mo(c, p, 5), rolls: [[{ p: 0.3, hint: "더 단단해질", fx: (c) => attr(c, p, "consistency", 1) }]] },
      { label: "팀 회식", cost: 1000, hint: "팀이 같이 기뻐할", always: (c) => { mo(c, p, 5); syn(c, 2); } },
    ];
  },
});

def({
  id: "P2", pol: "pos", cls: "random",
  find: (c) => {
    const sr = lastSeries(c.s);
    if (!sr || c.s.day - sr.day > 2) return 0;
    for (const g of sr.games) {
      if (g.winner !== c.s.user || !g.mvp || !g.box?.[g.mvp]) continue;
      const b = g.box[g.mvp];
      const p = c.s.players[g.mvp];
      if (!p || p.team !== c.s.user || !cdOk(c, `P2:${p.id}`, 60)) continue;
      if ((b.k + b.a) / Math.max(1, b.d) >= 8 || b.k >= 10) {
        c.p = p;
        return 3;
      }
    }
    return 0;
  },
  title: () => "명장면 화제",
  body: (c) => `${nm(c.p!)}의 지난 경기 하이라이트가 조회수 100만을 넘겼습니다.`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "하이라이트 굿즈 기획", cost: 3000, note: "그 선수를 내건 굿즈가 2주 동안 더 잘 팔릴 수 있어요.", rolls: [[{ p: 0.8, hint: "잘 팔릴", fx: (c) => { evState(c.s).goodsBoost = { pid: p.id, until: c.s.day + 14 }; quiet(c, `2주 동안 ${nm(p)} 굿즈 수요 ×1.5`); pfame(c, p, 1); } }]] },
      { label: "인터뷰 노출", hint: "이름을 알릴", always: (c) => { pfame(c, p, 2); tfame(c, 1); } },
      { label: "겸손하게", hint: "기분이 좋을", always: (c) => mo(c, p, 5), rolls: [[{ p: 0.4, hint: "더 성장할", fx: (c) => form(c, p, 1) }]] },
    ];
  },
});

def({
  id: "P3", pol: "pos", cls: "random",
  find: (c) => {
    // the team's two most famous (was: fame 50+, which on most teams meant one star or nobody)
    const p = leaderPick(c, roster(c), (x) => x.fame, (x) => cdOk(c, `P3:${x.id}`, 60));
    if (!p) return 0;
    c.p = p;
    return 1;
  },
  title: () => "팬레터 폭주",
  body: (c) => `${nm(c.p!)}에게 이번 주에만 팬레터가 세 상자 도착했습니다.`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "팬사인회", hint: "팬이 늘", always: (c) => { fans(c, 3); fat(c, p, 10); } },
      { label: "감사 영상", hint: "팬들이 기뻐할", always: (c) => { fans(c, 1); mo(c, p, 5); } },
      { label: "2주 뒤 팬미팅 약속", note: "약속한 날 팬미팅을 열면 팬이 크게 늘 거예요. 미루면 실망할 거예요.",
        always: (c) => { promise(c, "fanmeet", p.id, c.s.day + 14, 0); memo(c, p.id, "약속:팬미팅", "팬미팅 약속"); quiet(c, "2주 뒤 팬미팅을 열기로 했습니다"); } },
    ];
  },
});

/** Each player's birthday in the game: a fixed day of the year from his id. */
function isBirthday(p: Player, day: number): boolean {
  const d = dateOf(day);
  const doy = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000);
  return Math.floor(hashUnit(p.id + ":bday") * 365) === doy;
}

def({
  id: "P4", pol: "pos", cls: "random",
  find: (c) => {
    const p = roster(c).find((x) => isBirthday(x, c.s.day));
    if (!p) return 0;
    c.p = p;
    return 3;
  },
  title: () => "생일",
  body: (c) => `오늘은 ${nm(c.p!)}의 생일입니다.`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "깜짝 파티", cost: 800, hint: "감동할", always: (c) => { mo(c, p, 10); syn(c, 1); } },
      { label: "팬과 함께하는 생일 방송", hint: "팬이 늘", always: (c) => { fans(c, 1); mo(c, p, 6); } },
      { label: "하루 휴가", hint: "푹 쉴", always: (c) => { rest(c, p, 1); fat(c, p, -20); mo(c, p, 6); memo(c, p.id, "휴가받음", "생일 휴가"); } },
    ];
  },
});

def({
  id: "P5", pol: "pos", cls: "random",
  find: (c) => {
    // the mentor: one of the two oldest starters aged 24+ (was: 26+, often only one man on a team)
    const kids = roster(c).filter((p) => age(p, c.s.season) <= 20);
    const v = leaderPick(c, starters(c).filter((p) => age(p, c.s.season) >= 24), (p) => age(p, c.s.season), (p) => cdOk(c, `P5:${p.id}`, 60));
    const k = pickOne(c, kids.filter((x) => x !== v));
    if (!v || !k) return 0;
    c.p = v;
    c.q = k;
    return 1;
  },
  title: () => "베테랑의 멘토링 제안",
  body: (c) => `${nm(c.p!)}가 신인 ${nm(c.q!)}를 따로 봐 주고 싶다고 합니다.`,
  opts: (c) => {
    const v = c.p!, k = c.q!;
    const grow = (c: Ctx) => attr(c, k, lowestAttr(k), 1);
    return [
      { label: "수락", hint: "베테랑이 지칠", always: (c) => fat(c, v, 10), rolls: [[{ p: 0.7, hint: "신인이 클", fx: grow }]] },
      { label: "정식 프로그램으로", cost: 2000, always: (c) => mo(c, v, 5), rolls: [[{ p: 0.9, hint: "신인이 확실히 클", fx: grow }]] },
      { label: "다음에 하자", rolls: [[{ p: 0.5, hint: "서운해할", fx: (c) => mo(c, v, -3) }]] },
    ];
  },
});

/** The user's last n finished series, newest last. */
function lastN(s: GameState, n: number): Series[] {
  return s.series.filter((x) => x.done && (x.a === s.user || x.b === s.user)).sort((a, b) => a.day - b.day).slice(-n);
}

def({
  id: "P6", pol: "pos", cls: "random", team: true,
  find: (c) => {
    const l = lastN(c.s, 3);
    return l.length === 3 && l.every((x) => x.winner === c.s.user) && c.s.day - l[2].day <= 3 && cdOk(c, "P6", 30) ? 3 : 0;
  },
  title: () => "연승 회식",
  body: () => "시리즈 3연승입니다. 선수들 표정이 밝습니다.",
  opts: () => [
    { label: "고기 회식", cost: 1500, hint: "더 끈끈해질", always: (c) => { moList(c, roster(c), 6, "선수단 전원"); syn(c, 2); } },
    { label: "하루 휴가", hint: "기운을 되찾을", always: (c) => { for (const p of roster(c)) p.restDays = Math.max(p.restDays ?? 0, 1); fatList(c, roster(c), -20, "선수단 전원"); } },
    { label: "계속 달립니다", rolls: [[
      { p: 0.5, hint: "기세가 이어질", fx: (c) => syn(c, 2) },
      { p: 0.5, hint: "지칠", fx: (c) => fatList(c, roster(c), 10, "선수단 전원") },
    ]] },
  ],
});

def({
  id: "P7", pol: "pos", cls: "random", team: true,
  find: (c) => {
    if (!cdOk(c, "P7", 30) || starters(c).length < 5) return 0;
    const l = lastN(c.s, 2);
    if (l.length === 2 && l.every((x) => x.winner === c.s.user)) return 3;
    const rank = [...c.s.lck].sort((a, b) => c.s.teams[b].fame - c.s.teams[a].fame).indexOf(c.s.user);
    return rank >= 0 && rank < 3 ? 1 : 0;
  },
  title: () => "스폰서의 깜짝 제안",
  body: () => "스폰서가 선수단 광고 촬영을 제안했습니다.",
  opts: (c) => {
    const big = Math.round(c.t.fans / 40 / 100) * 100;
    const small = Math.round(c.t.fans / 100 / 100) * 100;
    return [
      { label: `광고 촬영 (+${money(big)})`, hint: "선수들이 지칠", always: (c) => { money_(c, "광고 수입", big); fatList(c, starters(c), 15, "주전"); },
        rolls: [[{ p: 0.2, hint: "한 명이 크게 지칠", fx: (c) => { const p = pickOne(c, starters(c)); if (p) after(c, "A3", p.id); } }]] },
      { label: `단발 협찬만 (+${money(small)})`, hint: "쏠쏠할", always: (c) => money_(c, "협찬 수입", small) },
      { label: "거절", rolls: [[{ p: 0.3, hint: "다음에 더 큰 제안이 올", fx: (c) => { memo(c, "team", "스폰서호감", "스폰서 제안을 정중히 거절"); quiet(c, "스폰서가 다음 시즌 계약을 더 신경 쓰겠다고 합니다"); } }]] },
    ];
  },
});

def({
  id: "P8", pol: "pos", cls: "random",
  find: (c) => {
    // one of the team's two most famous, the most famous twice as likely (was: always the most famous)
    const p = leaderPick(c, roster(c), (x) => x.fame, (x) => cdOk(c, `P8:${x.id}`, 60));
    if (!p) return 0;
    c.p = p;
    return 1;
  },
  title: () => "예능 출연 제의",
  body: (c) => `방송국이 ${nm(c.p!)}에게 예능 출연을 제의했습니다.`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: `${nm(p)}만 출연`, hint: "스타가 될", always: (c) => { pfame(c, p, 3); fans(c, 3); fat(c, p, 15); }, rolls: [[{ p: 0.25, hint: "연습이 밀릴", fx: (c) => after(c, "A5", p.id) }]] },
      { label: "팀 전체 출연", hint: "팀이 알려질", always: (c) => { fans(c, 5); fatList(c, roster(c), 10, "선수단 전원"); syn(c, 1); } },
      { label: "거절", always: (c) => quiet(c, "정중히 사양했습니다") },
    ];
  },
});

def({
  id: "P9", pol: "pos", cls: "random", team: true,
  find: (c) => {
    if (!cdOk(c, "P9", 30) || starters(c).length < 5) return 0;
    const mine = lineupOvr(c.s, c.t);
    const up = c.s.lck.filter((id) => id !== c.s.user && lineupOvr(c.s, c.s.teams[id]) > mine);
    const opp = pickOne(c, up);
    if (!opp) return 0;
    c.d.team = opp;
    return 1;
  },
  title: () => "강팀의 스크림 제안",
  body: (c) => `${teamName(c.s, c.d.team as string)}가 스크림을 같이 하자고 연락해 왔습니다.`,
  opts: (c) => [
    { label: "수락", hint: "합이 좋아질", always: (c) => syn(c, 2), rolls: [[
      { p: 0.7, hint: "많이 배울", fx: (c) => { const p = pickOne(c, starters(c)); if (p) attr(c, p, "macro", 1); } },
      { p: 0.3, hint: "전략이 드러날", fx: (c) => { memo(c, "team", "스크림노출", "강팀 스크림에서 전략 노출", c.d.team as string); quiet(c, `${teamName(c.s, c.d.team as string)}에 우리 전략이 드러났습니다`); } },
    ]] },
    { label: "비공개로만", hint: "무난할", always: (c) => syn(c, 1) },
    { label: "거절", always: (c) => quiet(c, "정중히 거절했습니다") },
  ],
});

def({
  id: "P10", pol: "pos", cls: "random", team: true,
  find: (c) => {
    const d = seasonDates(c.s.season);
    const stove = c.s.day < d.cup && roster(c).length >= 5;
    const msi = c.s.series.some((x) => x.comp === "MSI" && x.season === c.s.season && (x.a === c.s.user || x.b === c.s.user)) && d.msi - c.s.day > 0 && d.msi - c.s.day <= 14;
    return (stove || msi) && cdOk(c, "P10", 30) ? 3 : 0;
  },
  title: () => "해외 부트캠프 제안",
  body: () => "현지 구단이 2주 부트캠프를 같이 하자고 초청했습니다.",
  opts: () => [
    { label: "2주 해외 부트캠프", cost: 15000, hint: "합이 크게 좋아질", note: "주전마다 실력이 확 달라질 수도 있어요. 다들 지칠 거예요.",
      always: (c) => {
        syn(c, 6);
        fatList(c, starters(c), 15, "주전");
        for (const p of starters(c)) if (c.rng.chance(0.5)) attr(c, p, c.rng.pick(ATTR_KEYS), 1);
      } },
    { label: "국내 합숙", cost: 4000, hint: "단단해질", always: (c) => syn(c, 3) },
    { label: "생략", always: (c) => quiet(c, "평소대로 준비합니다") },
  ],
});

def({
  id: "P12", pol: "pos", cls: "random",
  find: (c) => {
    const xs = [...roster(c), ...academyOf(c.t).map((id) => c.s.players[id]).filter(Boolean)]
      .filter((p) => age(p, c.s.season) <= 21 && p.form >= 3 && cdOk(c, `P12:${p.id}`, 60));
    const p = pickOne(c, xs);
    if (!p) return 0;
    c.p = p;
    return 3;
  },
  title: () => "신인의 각성",
  body: (c) => `${nm(c.p!)}의 최근 경기력이 눈에 띄게 올라왔습니다. 코치진이 놀라워합니다.`,
  opts: (c) => {
    const p = c.p!;
    const canStart = !p.academy && !isStarter(c, p) && !p.scandal;
    return [
      { label: canStart ? "주전 기회를 줍니다" : "더 큰 역할을 맡깁니다", hint: "의욕이 넘칠", always: (c) => {
        mo(c, p, 15);
        if (canStart) { c.t.lineup[p.role] = p.id; c.lines.push(`${nm(p)} ${ROLE_KO[p.role]} 주전 기용`); }
      }, rolls: [[{ p: 0.6, hint: "더 크게 성장할", fx: (c) => pot(c, p, 2) }, { p: 0.2, hidden: true, fx: (c) => form(c, p, -2) }]] },
      { label: "꾸준히 훈련", rolls: [[{ p: 0.7, hint: "단단해질", fx: (c) => attr(c, p, "consistency", 1) }]] },
      { label: "칭찬만", hint: "기뻐할", always: (c) => mo(c, p, 6) },
    ];
  },
});

def({
  id: "P13", pol: "pos", cls: "random", team: true,
  find: (c) => {
    const sr = nextSeries(c.s);
    if (!sr || sr.day - c.s.day > 3 || sr.day === c.s.day || !cdOk(c, "P13", 30)) return 0;
    if (c.t.facilities.analysis < 1 && !staffOf(c).some((x) => x.role === "Analyst")) return 0;
    c.d.opp = oppOf(c.s, sr);
    return 1;
  },
  title: () => "분석관의 상대 약점 발견",
  body: (c) => `분석관이 ${teamName(c.s, c.d.opp as string)}의 밴픽 버릇을 찾아냈습니다.`,
  opts: () => [
    { label: "그 약점만 집중 공략", rolls: [[{ p: 0.6, hint: "통할", fx: (c) => moList(c, starters(c), 10, "주전") }, { p: 0.4, hint: "읽힐", fx: (c) => quiet(c, "상대도 이미 알고 있는 것 같습니다") }]] },
    { label: "팀 전체 공유", hint: "다 같이 좋아질", always: (c) => syn(c, 2) },
    { label: "큰 경기용으로 아껴 둠", note: "플레이오프·국제대회 때 주전들에게 힘이 될 거예요.", always: (c) => { memo(c, "team", "아껴둔약점", "분석 자료를 큰 경기용으로 아껴 둠"); quiet(c, "분석 자료를 아껴 두었습니다"); } },
  ],
});

def({
  id: "P14", pol: "pos", cls: "random", matchDay: false,
  find: (c) => {
    const sr = nextSeries(c.s);
    if (!sr || sr.day - c.s.day > 2 || sr.day === c.s.day) return 0;
    const opp = oppOf(c.s, sr);
    const oppName = c.s.teams[opp].name;
    const xs = starters(c).filter((p) => (p.lastTeamName === oppName || p.history.some((h) => h.includes(`${oppName} 입단`))) && cdOk(c, `P14:${p.id}`, 60));
    const p = pickOne(c, xs);
    if (!p) return 0;
    c.p = p;
    c.d.opp = opp;
    // days out counts down before the match day starts, so cover every day up to and including it
    c.d.days = sr.day - c.s.day + 1;
    const bench = roster(c).find((x) => x.role === p.role && !isStarter(c, x) && !x.scandal);
    if (bench) c.d.bench = bench.id;
    return 3;
  },
  title: () => "친정팀 더비",
  body: (c) => `다음 상대는 ${nm(c.p!)}의 친정팀 ${teamName(c.s, c.d.opp as string)}입니다.`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "각오 인터뷰", rolls: [[{ p: 0.6, hint: "불타오를", fx: (c) => form(c, p, 3) }, { p: 0.4, hint: "부담될", fx: (c) => form(c, p, -1) }]] },
      { label: "평소처럼", hint: "편하게 임할", always: (c) => mo(c, p, 3) },
      { label: c.d.bench ? "이번 경기는 쉬게 합니다" : "이번 경기는 쉬게 합니다 (같은 포지션 후보가 없음)", avail: !!c.d.bench, hint: "편해할",
        always: (c) => {
          out(c, p, Number(c.d.days ?? 2), "휴식");
          const b = c.s.players[c.d.bench as string];
          if (b && b.team === c.s.user && !b.scandal && !Object.values(c.t.lineup).includes(b.id)) { c.t.lineup[p.role] = b.id; c.lines.push(`${nm(b)} 대신 출전`); }
          mo(c, p, 5);
        } },
    ];
  },
});

def({
  id: "P15", pol: "pos", cls: "random",
  find: (c) => {
    const pairs: [Player, Player][] = [];
    for (const r of ROLES) {
      const st = c.t.lineup[r] ? c.s.players[c.t.lineup[r]!] : null;
      if (!st) continue;
      for (const b of roster(c)) if (b.role === r && b !== st && Math.abs(ovr(b) - ovr(st)) <= 2 && cdOk(c, `P15:${st.id}:${b.id}`, 60)) pairs.push([st, b]);
    }
    const pr = pickOne(c, pairs);
    if (!pr) return 0;
    [c.p, c.q] = pr;
    c.d.cdKey = `P15:${pr[0].id}:${pr[1].id}`;
    return 3;
  },
  title: () => "주전 경쟁",
  body: (c) => `${ROLE_KO[c.p!.role]} 주전 ${nm(c.p!)}와 ${nm(c.q!)}의 실력 차이가 거의 없습니다. 둘 다 의욕이 넘칩니다.`,
  opts: (c) => {
    const p = c.p!, q = c.q!;
    return [
      { label: "경쟁을 붙입니다", rolls: [[
        { p: 0.7, hint: "둘 다 클", fx: (c) => { attr(c, p, lowestAttr(p), 1); attr(c, q, lowestAttr(q), 1); } },
        { p: 0.3, hint: "한 명이 불만을 품을", fx: (c) => after(c, "A1", q.id) },
      ]] },
      { label: "상대에 따라 나눠 기용", hint: "둘 다 만족할", always: (c) => { mo(c, p, 5); mo(c, q, 5); } },
      { label: `${nm(p)}로 확정`, hint: `${nm(p)}가 힘이 날`, always: (c) => mo(c, p, 10), rolls: [[{ p: 0.5, hint: `${nm(q)}가 실망할`, fx: (c) => after(c, "A1", q.id) }]] },
    ];
  },
});

def({
  id: "P16", pol: "pos", cls: "random", team: true,
  find: (c) => {
    const sr = nextSeries(c.s);
    return sr && INTL.includes(sr.comp) && sr.day - c.s.day <= 4 && sr.day !== c.s.day && cdOk(c, "P16", 30) ? 3 : 0;
  },
  title: () => "현지 팬의 환영",
  body: () => "국제대회 현지에 도착하자 공항에 팬들이 몰려들었습니다.",
  opts: () => [
    { label: "팬서비스", hint: "팬이 늘", always: (c) => { fans(c, 4); fatList(c, roster(c), 10, "선수단 전원"); } },
    { label: "반나절 관광", hint: "기분 전환될", always: (c) => { moList(c, roster(c), 8, "선수단 전원"); fatList(c, roster(c), -10, "선수단 전원"); } },
    { label: "연습만", hint: "집중할", always: (c) => syn(c, 1) },
  ],
});

// ===== low morale (do not count toward the weekly 2) =====
/** chance on a day = (line - morale) / line x 25% */
const moraleChance = (line: number, m: number) => (m >= line ? 0 : ((line - m) / line) * 0.25);

def({
  id: "M1", pol: "neg", cls: "morale",
  find: (c) => {
    const st = starters(c);
    // 21 days for each player, not each pair (design 6-2): keyed by pair, a hot-tempered starter is in every
    // pair and came straight back with the next teammate, a quarrel every few days for the same player
    const pairs: { a: Player; b: Player; pr: number }[] = [];
    for (let i = 0; i < st.length; i++) for (let j = i + 1; j < st.length; j++) {
      const a = st[i], b = st[j];
      if (a.persona.temper < 0.6 && b.persona.temper < 0.6) continue;
      if (!cdOk(c, `m:M1:${a.id}`, MORALE_CD) || !cdOk(c, `m:M1:${b.id}`, MORALE_CD)) continue;
      let pr = moraleChance(50, (a.morale + b.morale) / 2);
      if (hasMemo(c.s, a.id, "앙금", 9999, b.id) || hasMemo(c.s, b.id, "앙금", 9999, a.id)) pr *= 2;
      if (pr > 0) pairs.push({ a, b, pr });
    }
    const best = topBy(c, pairs, (x) => x.pr);
    if (!best) return 0;
    c.p = best.a;
    c.q = best.b;
    return Math.min(1, best.pr);
  },
  title: () => "팀 내 언쟁",
  body: (c) => `연습 도중 ${nm(c.p!)}와 ${nm(c.q!)}가 언성을 높였습니다. 분위기가 싸늘합니다.`,
  opts: (c) => {
    const a = c.p!, b = c.q!;
    const side = (x: Player, y: Player): Opt => ({
      label: `${nm(x)}의 편을 듭니다`, hint: `${nm(x)}는 힘이 날`, note: `${nm(y)}는 서운해할 거예요.`,
      always: (c) => { mo(c, x, 10); mo(c, y, -15); syn(c, -3); memo(c, x.id, "편애", `${nm(y)}와의 언쟁에서 편을 들어 줌`, y.id); memo(c, y.id, "앙금", `${nm(x)}와의 언쟁에서 밀림`, x.id); },
      rolls: [[{ p: 0.3, hint: `${nm(y)}가 등을 돌릴`, fx: (c) => after(c, "A6", y.id) }]],
    });
    return [
      { label: "감독이 중재합니다", rolls: [[
        { p: 0.6, hint: "풀릴", fx: (c) => { syn(c, 2); mo(c, a, 5); mo(c, b, 5); } },
        { p: 0.4, hint: "어색해질", fx: (c) => syn(c, -2) },
      ]] },
      side(a, b),
      side(b, a),
      { label: "내버려 둡니다", rolls: [[
        { p: 0.5, hint: "알아서 풀릴", fx: (c) => syn(c, 1) },
        { p: 0.5, hint: "골이 깊어질", fx: (c) => { syn(c, -5); memo(c, a.id, "앙금", `${nm(b)}와 앙금`, b.id); memo(c, b.id, "앙금", `${nm(a)}와 앙금`, a.id); } },
      ]] },
    ];
  },
});

def({
  id: "M2", pol: "neg", cls: "morale",
  find: (c) => {
    const st = headCoachOf(c);
    if (!st) return 0;
    const p = topBy(c, roster(c).filter((x) => x.morale < 45 && cdOk(c, `m:M2:${x.id}`, MORALE_CD)), (x) => -x.morale);
    if (!p) return 0;
    c.p = p;
    c.d.staff = st.id;
    return moraleChance(45, p.morale);
  },
  title: () => "코치와 선수의 전술 충돌",
  body: (c) => `${nm(c.p!)}가 ${c.s.staff[c.d.staff as string].name}의 지시에 공개적으로 반발했습니다.`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "코치 편", hint: "선수가 위축될", always: (c) => mo(c, p, -10), rolls: [[{ p: 0.5, hint: "기강이 설", fx: (c) => syn(c, 2) }]] },
      { label: "선수 편", hint: "선수가 살아날", always: (c) => mo(c, p, 8), rolls: [[{ p: 0.25, hint: "코치가 서운해할", fx: (c) => after(c, "N7", undefined, undefined, { staff: c.d.staff }) }]] },
      { label: "절충안", rolls: [[
        { p: 0.6, hint: "무난할", fx: (c) => quiet(c, "일단 넘어갔습니다") },
        { p: 0.4, hint: "둘 다 불만일", fx: (c) => { mo(c, p, -3); syn(c, -1); } },
      ]] },
    ];
  },
});

def({
  id: "M3", pol: "neg", cls: "morale",
  find: (c) => {
    const p = topBy(c, roster(c).filter((x) => x.morale < 30 && cdOk(c, `m:M3:${x.id}`, MORALE_CD)), (x) => -x.morale);
    if (!p) return 0;
    c.p = p;
    return moraleChance(30, p.morale);
  },
  title: () => "말수가 줄어든 선수",
  body: (c) => `${nm(c.p!)}가 요즘 연습이 끝나면 바로 방으로 들어갑니다. 말수가 눈에 띄게 줄었습니다.`,
  opts: (c) => {
    const p = c.p!;
    const pt = clamp((0.5 + motivate(c) * 0.004) * trust(c, p), 0.05, 0.9);
    const again = countMemo(c.s, p.id, "말수", 365) >= 2; // this M3 already left its own 말수 memo (eventsDay), so 2 means a second time
    return [
      { label: "1:1 면담", rolls: [[
        { p: pt, hint: "속마음을 털어놓을", fx: (c) => mo(c, p, 12) },
        { p: 1 - pt, hint: "더 닫힐", fx: (c) => { mo(c, p, -2); if (again && p.morale < 15) maybe(c, 0.4, "A6", p.id); } },
      ]] },
      { label: "이틀 쉬게 합니다", hint: "기운을 차릴", always: (c) => { rest(c, p, 2); fat(c, p, -20); mo(c, p, 6); memo(c, p.id, "휴가받음", "이틀 휴식"); } },
      { label: "팀원들에게 챙겨 달라고 부탁", rolls: [[{ p: 0.7, hint: "팀 안에서 풀릴", fx: (c) => { mo(c, p, 5); syn(c, 1); } }]] },
    ];
  },
});

def({
  id: "M4", pol: "neg", cls: "morale", team: true,
  find: (c) => {
    const st = starters(c);
    if (st.length < 5 || !cdOk(c, "m:M4:team", MORALE_CD)) return 0;
    return moraleChance(45, st.reduce((a, p) => a + p.morale, 0) / st.length);
  },
  title: () => "팀 분위기 침체",
  body: () => "주전들이 서로 눈을 마주치지 않습니다. 연습실이 조용합니다.",
  opts: () => [
    { label: "팀 미팅", rolls: [[
      { p: 0.6, hint: "다시 뭉칠", fx: (c) => moList(c, starters(c), 5, "주전") },
      { p: 0.4, hint: "겉돌", fx: (c) => moList(c, starters(c), -2, "주전") },
    ]] },
    { label: "외부 활동", cost: 2000, hint: "기분 전환될", always: (c) => { moList(c, roster(c), 8, "선수단 전원"); fatList(c, roster(c), -10, "선수단 전원"); } },
    { label: "\"내가 책임진다\" 감독 선언", hint: "선수들이 따를", note: "2주 안에 시리즈 2승을 못 하면 크게 실망할 거예요.",
      always: (c) => { moList(c, roster(c), 10, "선수단 전원"); promise(c, "rebound", undefined, c.s.day + 14, c.s.stats.seriesW); } },
  ],
});

// ===== aftermaths (scheduled by earlier choices) =====
const onTeam = (c: Ctx) => !!c.p && c.p.team === c.s.user;

def({
  id: "A1", pol: "neg", cls: "after", find: onTeam,
  title: () => "출전 불만",
  body: (c) => `${nm(c.p!)}: "저도 경기에 나가고 싶습니다. 계속 벤치에 있을 거면 차라리 이적을 시켜 주세요."`,
  opts: (c) => {
    const p = c.p!;
    const sr = nextSeries(c.s);
    const due = sr ? sr.day : c.s.day + 7;
    return [
      { label: "다음 경기 주전 약속", hint: "기뻐할", note: "다음 경기에 안 쓰면 크게 실망할 거예요.",
        always: (c) => { mo(c, p, 15); promise(c, "starter", p.id, due, gamesOf(p)); memo(c, p.id, "약속:주전", "다음 경기 주전 약속"); } },
      { label: "이적 시장에 올려 줍니다", hint: "받아들일", always: (c) => { mo(c, p, 8); p.listed = true; quiet(c, `${nm(p)} 이적 목록 등록`); } },
      { label: "지금은 참아 주세요", hint: "실망할", always: (c) => mo(c, p, -8), rolls: [[{ p: 0.3, hint: "떠나려 할", fx: (c) => after(c, "A6", p.id) }]] },
    ];
  },
});

def({
  id: "A2", pol: "neg", cls: "after", find: onTeam,
  title: () => "연봉 불만",
  body: (c) => `${nm(c.p!)}: "제 활약에 비해 대우가 너무 적다고 생각합니다."`,
  opts: (c) => {
    const p = c.p!;
    const bonus = Math.round((salaryAsk(p, c.s.season) * 0.08) / 100) * 100;
    return [
      { label: "보너스 지급", cost: bonus, hint: "기뻐할", always: (c) => mo(c, p, 14) },
      { label: "재계약 때 반영 약속", hint: "기다려 줄", note: "재계약 요구액이 조금 오를 거예요.", always: (c) => { mo(c, p, 6); memo(c, p.id, "반영약속", "재계약 때 반영 약속"); } },
      { label: "계약은 계약입니다", hint: "서운해할", always: (c) => mo(c, p, -10), rolls: [[{ p: 0.2, hint: "떠나려 할", fx: (c) => after(c, "A6", p.id) }]] },
    ];
  },
});

def({
  id: "A3", pol: "neg", cls: "after", find: onTeam,
  title: () => "번아웃",
  body: (c) => `${nm(c.p!)}: "요즘 게임이 재미가 없어요. 머리가 하얘집니다."`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "3일 완전 휴식", hint: "기운을 되찾을", always: (c) => { rest(c, p, 3); fat(c, p, -35); mo(c, p, 10); syn(c, -1); memo(c, p.id, "휴가받음", "번아웃 휴식"); } },
      { label: "심리 상담 지원", cost: 2000, hint: "마음이 편해질", always: (c) => mo(c, p, 7), rolls: [[{ p: 0.6, hint: "안정을 찾을", fx: (c) => attr(c, p, "consistency", 1) }]] },
      { label: "버텨야 합니다", hint: "더 지칠", always: (c) => { mo(c, p, -6); memo(c, p.id, "혹사", "번아웃에도 버팀"); }, rolls: [[{ p: 0.4, hint: "독기가 오를", fx: (c) => attr(c, p, "mechanics", 1) }]] },
    ];
  },
});

def({
  id: "A4", pol: "neg", cls: "after", find: onTeam,
  title: () => "슬럼프",
  body: (c) => `${nm(c.p!)}가 최근 솔로랭크에서도 연패 중입니다. 표정이 어둡습니다.`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "강도 높은 개인 훈련", hint: "지칠", always: (c) => { fat(c, p, 15); mo(c, p, 4); }, rolls: [[{ p: 0.6, hint: "감을 찾을", fx: (c) => attr(c, p, "mechanics", 1) }]] },
      { label: "VOD로 차분히 복기", hint: "차분해질", always: (c) => mo(c, p, 4), rolls: [[{ p: 0.6, hint: "운영이 늘", fx: (c) => attr(c, p, "macro", 1) }]] },
      { label: "쉬게 합니다", hint: "기운을 차릴", always: (c) => { fat(c, p, -25); mo(c, p, 9); } },
    ];
  },
});

def({
  id: "A5", pol: "neg", cls: "after", find: onTeam,
  title: () => "연습 지각",
  body: (c) => `${nm(c.p!)}가 이번 주에만 세 번째 연습에 늦었습니다.`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "벌금", hint: "기분이 상할", always: (c) => mo(c, p, -5), rolls: [[{ p: 0.7, hint: "기강이 설", fx: (c) => syn(c, 1) }]] },
      { label: "1:1 면담", hint: "마음을 열", always: (c) => mo(c, p, 5) },
      { label: "2주 출전 정지 (14일 출전 불가)", hint: "크게 실망할", always: (c) => { out(c, p, 14, "징계"); mo(c, p, -12); syn(c, 2); } },
    ];
  },
});

def({
  id: "A6", pol: "neg", cls: "after", find: onTeam,
  title: () => "이적 요청",
  body: (c) => `${nm(c.p!)}가 공식적으로 이적을 요청했습니다.`,
  opts: (c) => {
    const p = c.p!;
    const pt = 0.4 * trust(c, p);
    return [
      { label: "이적 목록에 올립니다", hint: "받아들일", always: (c) => { p.listed = true; quiet(c, `${nm(p)} 이적 목록 등록`); mo(c, p, 5); } },
      { label: "설득합니다", rolls: [[
        { p: pt, hint: "마음을 돌릴", fx: (c) => aff(c, p, 10) },
        { p: 1 - pt, hint: "실망할", fx: (c) => mo(c, p, -10) },
      ]] },
      { label: "거절합니다", hint: "크게 실망할", always: (c) => { mo(c, p, -15); aff(c, p, -20); } },
    ];
  },
});

def({
  id: "A7", pol: "neg", cls: "after", team: true,
  find: (c) => owedOf(c).length > 0,
  title: () => "집단 연습 거부",
  body: () => "급여가 밀린 선수들이 돈을 받기 전까지 연습에 나오지 않겠다고 선언했습니다.",
  opts: (c) => {
    const owed = owedOf(c).reduce((a, x) => a + x.amt, 0);
    return [
      { label: `즉시 지급 (${money(owed)})`, avail: c.t.cash >= owed && owed > 0, hint: "연습에 돌아올", always: (c) => payOwed(c) },
      { label: "3일 연습 중단을 받아들임", hint: "조금 누그러질", always: (c) => { for (const p of roster(c)) p.restDays = Math.max(p.restDays ?? 0, 3); c.lines.push("선수단 전원 3일 훈련 없음"); } },
      { label: "강행합니다", hint: "크게 반발할", always: (c) => { moList(c, roster(c), -15, "선수단 전원"); syn(c, -5); } },
    ];
  },
});

def({
  id: "A8", pol: "neg", cls: "after", find: onTeam,
  title: () => "논란 확산",
  body: (c) => `${nm(c.p!)}의 논란이 다시 커지고 있습니다. 감싸 준 구단에도 비판이 쏟아집니다.${FICTION}`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "뒤늦은 징계 (14일 출전 불가)", hint: "여론이 가라앉을", always: (c) => { out(c, p, 14, "징계"); tfame(c, 2); } },
      { label: "끝까지 감쌉니다", hint: "팬이 더 줄", always: (c) => { fans(c, -4); mo(c, p, 5); } },
      { label: "계약 해지", hint: "단호해 보일", always: (c) => { releasePlayer(c.s, p, "품위 손상"); autoLineupUser(c); c.lines.push(`${nm(p)} 방출`); } },
    ];
  },
});

def({
  id: "A9", pol: "pos", cls: "after", find: onTeam,
  title: () => "믿음의 보답",
  body: (c) => `${nm(c.p!)}: "그때 믿어 주셔서 감사합니다. 경기력으로 갚겠습니다."`,
  opts: (c) => {
    const p = c.p!;
    const up: Branch[][] = [[{ p: 0.6, hint: "폼이 오를", fx: (c) => form(c, p, 2) }]];
    const bonus = Math.round((salaryAsk(p, c.s.season) * 0.05) / 100) * 100;
    return [
      { label: "칭찬해 줍니다", hint: "기뻐할", always: (c) => mo(c, p, 8), rolls: up },
      { label: "공개 인터뷰", hint: "팬이 늘", always: (c) => { fans(c, 2); mo(c, p, 5); }, rolls: up },
      { label: "보너스 지급", cost: bonus, hint: "감동할", always: (c) => { mo(c, p, 12); aff(c, p, 15); }, rolls: up },
    ];
  },
});

def({
  id: "A10", pol: "pos", cls: "after", find: onTeam,
  title: () => "멘탈 성장",
  body: (c) => `악플을 두 번이나 이겨 낸 ${nm(c.p!)}가 한결 단단해졌습니다.`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "인터뷰로 이야기를 들려줍니다", hint: "팬이 늘", always: (c) => fans(c, 2) },
      { label: "조용히 격려", hint: "더 단단해질", always: (c) => attr(c, p, "consistency", 1) },
      { label: "후배들에게 조언을 부탁", hint: "팀이 단단해질", always: (c) => syn(c, 2) },
    ];
  },
});

def({
  id: "A11", pol: "pos", cls: "after", find: onTeam,
  title: () => "팬미팅 약속의 날",
  body: (c) => `${nm(c.p!)}가 팬들과 약속한 팬미팅 날입니다.`,
  opts: (c) => {
    const p = c.p!;
    return [
      { label: "팬미팅을 엽니다", hint: "팬이 크게 늘", always: (c) => { fans(c, 4); mo(c, p, 5); fat(c, p, 10); } },
      { label: "미룹니다", hint: "팬들이 실망할", always: (c) => fans(c, -3) },
    ];
  },
});

const BY_ID = new Map(DEFS.map((d) => [d.id, d]));

// ---------- making and resolving events ----------
function ctxFor(s: GameState, rng: Rng, data: GameData | null, defId: string, depth = 0): Ctx {
  return { s, rng, data, t: s.teams[s.user], p: null, q: null, d: {}, depth, def: defId, lines: [] };
}

function phrase(stem: string, p: number): string | null {
  if (p >= 0.7) return `${stem} 거예요`;
  if (p >= 0.2) return `${stem} 수도 있어요`;
  return null;
}

function makeEvent(c: Ctx, d: Def): ModalEvent {
  const opts = d.opts(c);
  return {
    id: `ev${c.s.day}-${d.id}-${c.p?.id ?? "team"}-${Math.floor(c.rng.next() * 1e6)}`,
    kind: d.id,
    def: d.id,
    title: d.title(c),
    body: d.body(c),
    player: c.p?.id,
    other: c.q?.id,
    depth: c.depth,
    data: { ...c.d },
    options: opts.map((o, i) => {
      const hints: string[] = [];
      if (o.hint) hints.push(`${o.hint} 거예요`);
      const probs = (o.rolls ?? []).map((roll) => roll.map((b) => b.p));
      for (const roll of o.rolls ?? []) for (const b of roll) {
        if (b.hidden || !b.hint) continue;
        const w = phrase(b.hint, b.p);
        if (w) hints.push(w);
      }
      if (o.note) hints.push(o.note);
      const disabled = o.avail === false || (o.cost !== undefined && o.cost > c.t.cash);
      return { label: o.label, desc: hints.join(" · "), effect: String(i), hints, cost: o.cost, disabled, probs };
    }),
  };
}

function fire(s: GameState, c: Ctx, d: Def) {
  const ev = evState(s);
  s.events.push(makeEvent(c, d));
  ev.recent.push(d.pol);
  if (ev.recent.length > 10) ev.recent.splice(0, ev.recent.length - 10);
}

/** Apply the chosen option of a choice event (ModalEvent.def is set). */
export function resolveChoice(s: GameState, evId: string, opt: number) {
  const me = s.events.find((e) => e.id === evId);
  if (!me || !me.def) return;
  const d = BY_ID.get(me.def);
  const o = me.options[opt];
  if (!d) {
    // an event a later version renamed or removed: let it go rather than leave a modal that cannot close
    s.events = s.events.filter((e) => e.id !== evId);
    return;
  }
  if (!o || o.disabled) return;
  if (o.cost !== undefined && o.cost > s.teams[s.user].cash) return;
  s.events = s.events.filter((e) => e.id !== evId);
  const rng = new Rng((s.rng ^ hashUnit(evId) * 0x7fffffff) >>> 0);
  const c = ctxFor(s, rng, null, d.id, me.depth ?? 0);
  c.p = me.player ? s.players[me.player] ?? null : null;
  c.q = me.other ? s.players[me.other] ?? null : null;
  c.d = { ...(me.data ?? {}) };
  const ev = evState(s);
  ev.result = undefined;
  const opts = d.opts(c);
  const od = opts[opt];
  if (!od) return;
  if (o.cost) money_(c, me.def === "A2" || me.def === "A9" ? "선수 보너스" : "이벤트 비용", -o.cost);
  od.always?.(c);
  (od.rolls ?? []).forEach((roll, ri) => {
    const probs = o.probs?.[ri] ?? roll.map((b) => b.p);
    let r = rng.next();
    for (let bi = 0; bi < roll.length; bi++) {
      r -= probs[bi] ?? 0;
      if (r < 0) {
        roll[bi].fx?.(c);
        break;
      }
    }
  });
  // a ban or rest chosen on a match-day morning: fill the empty slot before the match (ensureUserLineup already ran)
  if (userSeriesOn(s, s.day)) autoLineupUser(c);
  if (!c.lines.length) c.lines.push("별다른 일은 없었습니다");
  // scandal lines stay on a player's profile, so they keep the fiction mark
  const log = `${me.title}: ${o.label}${d.id === "N20" || d.id === "A8" ? FICTION : ""}`;
  for (const p of [c.p, c.q]) if (p) addMemo(s, p.id, { tag: "기록", day: s.day, ev: d.id, text: log });
  if (d.team || !c.p) addMemo(s, "team", { tag: "기록", day: s.day, ev: d.id, text: log });
  // an option may ask to open a screen (N8 opens the renewal talk); TS narrowed result to undefined above
  const open = (ev.result as EvState["result"])?.open;
  ev.result = { title: `${me.title} — ${o.label}`, lines: c.lines, open };
  s.rng = rng.state;
}

// ---------- the daily check ----------
function balancePol(s: GameState, rng: Rng): Pol {
  const r = evState(s).recent;
  const neg = r.filter((x) => x === "neg").length;
  const pos = r.length - neg;
  if (r.length >= 10 && neg >= 7) return "pos";
  if (r.length >= 10 && pos >= 6) return "neg";
  return rng.chance(0.6) ? "neg" : "pos";
}

function cdKey(c: Ctx, d: Def): string {
  if (c.d.cdKey) return c.d.cdKey as string;
  if (d.cls === "morale") return `m:${d.id}:${c.p?.id ?? "team"}`;
  return d.team || !c.p ? d.id : `${d.id}:${c.p.id}`;
}

/** Cooldowns a low-morale event starts: one per player it names (a quarrel, M1, names two). */
function moraleCdKeys(c: Ctx, d: Def): string[] {
  const keys = [cdKey(c, d)];
  if (c.q && !c.d.cdKey) keys.push(`m:${d.id}:${c.q.id}`);
  return keys;
}

function checkPromises(s: GameState, rng: Rng) {
  const ev = evState(s);
  const keep: typeof ev.promises = [];
  for (const pr of ev.promises) {
    if (s.day <= pr.due) { keep.push(pr); continue; }
    const c = ctxFor(s, rng, null, pr.ev, pr.depth);
    const p = pr.pid ? s.players[pr.pid] : null;
    if (pr.pid && (!p || p.team !== s.user)) continue;
    c.p = p;
    switch (pr.kind) {
      case "starter":
      case "raise": {
        const kept = pr.kind === "starter" ? gamesOf(p!) > pr.base : !!p!.contract && p!.contract.salary >= pr.base * 1.1;
        if (kept) {
          inbox(s, `${p!.name}에게 한 약속을 지켰습니다.`);
          addMemo(s, p!.id, { tag: "약속지킴", day: s.day, ev: pr.ev, text: "구단이 약속을 지킴" });
          maybe(c, 0.5, "A9", p!.id);
        } else {
          p!.morale = clamp(p!.morale - 20, 0, 100);
          p!.affinity = clamp((p!.affinity ?? 0) - 20, -100, 100);
          addMemo(s, p!.id, { tag: "배신", day: s.day, ev: pr.ev, text: pr.kind === "starter" ? "출전 약속을 어김" : "연봉 재협상 약속을 어김" });
          inbox(s, `${p!.name}에게 한 ${pr.kind === "starter" ? "출전" : "연봉"} 약속을 지키지 못했습니다. 사기 -20, 구단 호감 -20.`);
        }
        break;
      }
      case "pay": {
        const still = owedOf(c);
        if (still.length) {
          for (const x of roster(c)) x.morale = clamp(x.morale - 20, 0, 100);
          inbox(s, "약속한 7일이 지났는데 밀린 연봉이 남아 있습니다. 선수단 전원 사기 -20.");
        } else inbox(s, "약속대로 밀린 연봉을 모두 정리했습니다.");
        break;
      }
      case "fanmeet":
        if (p) after(c, "A11", p.id, undefined, undefined, s.day);
        break;
      case "rebound": {
        const wins = s.stats.seriesW - pr.base;
        if (wins >= 2) inbox(s, `"내가 책임진다"는 선언 뒤 2주 동안 시리즈 ${wins}승. 선수들이 감독을 믿고 따릅니다.`);
        else {
          for (const x of roster(c)) x.morale = clamp(x.morale - 10, 0, 100);
          c.t.fame = clamp(c.t.fame - 1, 0, 100);
          inbox(s, `"내가 책임진다"는 선언 뒤 2주 동안 시리즈 ${wins}승에 그쳤습니다. 선수단 전원 사기 -10, 구단 명성 -1.`);
        }
        break;
      }
    }
  }
  ev.promises = keep;
}

/** On the morning of a user match: memories that pay off before this series. */
function preMatch(s: GameState) {
  const sr = userSeriesOn(s, s.day);
  if (!sr) return;
  const ev = evState(s);
  const key = `pre:${sr.id}`;
  if (ev.cd[key] !== undefined) return;
  ev.cd[key] = s.day;
  const t = s.teams[s.user];
  const st = ROLES.map((r) => t.lineup[r]).filter(Boolean).map((id) => s.players[id!]).filter(Boolean);
  const team = ev.memo.team ?? [];
  const saved = team.findIndex((m) => m.tag === "아껴둔약점");
  if (saved >= 0 && bigSeries(sr)) {
    team.splice(saved, 1);
    for (const p of st) p.morale = clamp(p.morale + 12, 0, 100);
    inbox(s, "아껴 둔 분석 자료를 꺼냈습니다. 주전 사기 +12.");
  }
  const opp = oppOf(s, sr);
  const leak = team.findIndex((m) => m.tag === "스크림노출" && m.other === opp);
  if (leak >= 0) {
    team.splice(leak, 1);
    for (const p of st) p.morale = clamp(p.morale - 5, 0, 100);
    inbox(s, `${teamName(s, opp)}가 스크림에서 본 우리 전략을 알고 있습니다. 주전 사기 -5.`);
  }
}

/** Once a day, after the day has moved on (advanceDay). */
export function eventsDay(s: GameState, data: GameData, rng: Rng) {
  if (s.over) return;
  const ev = evState(s);
  const ws = weekStartOf(s.day);
  if (ev.week.start !== ws) ev.week = { start: ws, n: 0 };
  checkPromises(s, rng);
  preMatch(s);
  if (s.events.length) return;
  if (ev.goodsBoost && s.day > ev.goodsBoost.until) ev.goodsBoost = undefined;
  // 1) aftermaths that are due
  ev.queue = ev.queue.filter((x) => s.day <= x.until);
  ev.queue.sort((a, b) => a.due - b.due);
  for (let i = 0; i < ev.queue.length; i++) {
    const item = ev.queue[i];
    if (item.due > s.day) break;
    const d = BY_ID.get(item.def);
    ev.queue.splice(i--, 1);
    if (!d) continue;
    const c = queuedCtx(s, rng, data, item);
    if (d.find && !d.find(c)) continue;
    if (c.p && c.p.team !== s.user) continue;
    fire(s, c, d);
    return;
  }
  // 2) low morale (not counted toward the weekly 2)
  if (s.day - ev.lastMorale >= MORALE_GAP) {
    for (const d of rng.shuffle(DEFS.filter((x) => x.cls === "morale"))) {
      const c = ctxFor(s, rng, data, d.id);
      const pr = Number(d.find?.(c) ?? 0);
      if (pr > 0 && rng.chance(pr)) {
        for (const k of moraleCdKeys(c, d)) ev.cd[k] = s.day;
        ev.lastMorale = s.day;
        for (const p of [c.p, c.q]) if (p) addMemo(s, p.id, { tag: d.id === "M3" ? "말수" : "사기저하", day: s.day, ev: d.id, text: `사기 저하: ${d.title(c)}` });
        fire(s, c, d);
        return;
      }
    }
  }
  // 3) random, at most 2 a week
  if (ev.week.n >= RANDOM_WEEK_MAX || !rng.chance(RANDOM_DAILY)) return;
  const matchDay = !!userSeriesOn(s, s.day);
  const first = balancePol(s, rng);
  for (const pol of [first, first === "neg" ? "pos" : "neg"] as Pol[]) {
    const cands: { d: Def; c: Ctx; w: number }[] = [];
    for (const d of DEFS) {
      if (d.cls !== "random" || d.pol !== pol || !!d.matchDay !== matchDay) continue;
      const c = ctxFor(s, rng, data, d.id);
      const w = Number(d.find?.(c) ?? 0);
      if (w <= 0) continue;
      if (!cdOk(c, cdKey(c, d), d.team || !c.p ? 30 : 60)) continue;
      // one random event per player at a time (RANDOM_PLAYER_GAP): another player's event goes instead.
      // Team events (N10 names the most-owed player) are about everyone and do not count.
      if (!d.team && [c.p, c.q].some((x) => x && !cdOk(c, `rnd:${x.id}`, RANDOM_PLAYER_GAP))) continue;
      cands.push({ d, c, w });
    }
    const pick = rng.weighted(cands, (x) => x.w);
    if (!pick) continue;
    ev.cd[cdKey(pick.c, pick.d)] = s.day;
    if (!pick.d.team) for (const x of [pick.c.p, pick.c.q]) if (x) ev.cd[`rnd:${x.id}`] = s.day;
    ev.week.n++;
    fire(s, pick.c, pick.d);
    return;
  }
}

function queuedCtx(s: GameState, rng: Rng, data: GameData | null, item: EvQueued): Ctx {
  const c = ctxFor(s, rng, data, item.def, item.depth);
  c.p = item.pid ? s.players[item.pid] ?? null : null;
  c.q = item.other ? s.players[item.other] ?? null : null;
  c.d = { ...(item.data ?? {}) };
  return c;
}

// ---------- the user's series ----------
/**
 * Called when the user's series is over, before its results move morale (closeUserSeries): the set-break talk
 * lasted for the rest of this series only, so it is given back first (after would mis-count at 0 or 100).
 */
export function endSetBreak(s: GameState, sr: Series) {
  const ev = evState(s);
  const t = s.teams[s.user];
  if (ev.setBreak?.sr !== sr.id) return;
  for (const [pid, v] of Object.entries(ev.setBreak.morale)) {
    const p = s.players[pid];
    if (p) p.morale = clamp(p.morale - v, 0, 100);
  }
  t.synergy = clamp(t.synergy - ev.setBreak.synergy, 0, 100);
  ev.setBreak = undefined;
}

/** Called after the user's series result is in (closeUserSeries): settles a taunt answered before it. */
export function afterUserSeries(s: GameState, sr: Series, rng: Rng) {
  const ev = evState(s);
  const team = ev.memo.team ?? [];
  const i = team.findIndex((m) => m.tag === "도발" && m.other === sr.id);
  if (i >= 0) {
    team.splice(i, 1);
    const c = ctxFor(s, rng, null, "N13", 0);
    const st = starters(c);
    if (sr.winner === s.user) {
      moList(c, st, 10, "주전");
      fans(c, 3);
      inbox(s, `도발에 맞받아친 경기를 이겼습니다. ${c.lines.join(", ")}.`);
    } else {
      moList(c, st, -12, "주전");
      const p = pickOne(c, st);
      if (p) maybe(c, 0.4, "A4", p.id);
      inbox(s, `도발에 맞받아친 경기를 졌습니다. ${c.lines.join(", ")}.`);
    }
  }
}

export interface SetBreakOpt { label: string; hints: string[] }
const SET_BREAK: { label: string; branches: { p: number; hint: string; morale?: number; synergy?: number }[] }[] = [
  { label: "강하게 질책", branches: [{ p: 0.5, hint: "정신이 번쩍 들", morale: 8 }, { p: 0.5, hint: "주눅 들", morale: -8 }] },
  { label: "격려", branches: [{ p: 0.8, hint: "분위기가 살아날", morale: 5 }] },
  { label: "밴픽 전략을 바꿉니다", branches: [{ p: 0.6, hint: "허를 찌를", synergy: 3 }] },
];

/** The set-break talk shows after a lost game when the series goes on, once a series. */
export function setBreakDue(s: GameState, sr: Series): boolean {
  const last = sr.games.at(-1);
  if (!last || sr.bo < 3 || last.winner === s.user) return false;
  const need = Math.ceil(sr.bo / 2);
  if (sr.wa >= need || sr.wb >= need) return false;
  // only when behind (0:1, 1:2, 0:2), not after dropping a game at 1:1 or from 2:0
  const mine = sr.a === s.user ? sr.wa : sr.wb;
  const theirs = sr.a === s.user ? sr.wb : sr.wa;
  if (mine >= theirs) return false;
  const ev = evState(s);
  return ev.setBreak?.sr !== sr.id;
}

export function setBreakOptions(): SetBreakOpt[] {
  return SET_BREAK.map((o) => ({ label: o.label, hints: o.branches.map((b) => phrase(b.hint, b.p)).filter((x): x is string => !!x) }));
}

/** Apply the set-break choice for the rest of the series. Returns the result lines. */
export function chooseSetBreak(s: GameState, sr: Series, i: number): string[] {
  const ev = evState(s);
  const t = s.teams[s.user];
  const rng = new Rng((s.rng ^ (sr.games.length * 7919 + i * 31)) >>> 0);
  const o = SET_BREAK[i];
  const st = [...new Set(ROLES.map((r) => t.lineup[r]).filter(Boolean))].map((id) => s.players[id!]).filter(Boolean);
  const sb = { sr: sr.id, morale: {} as Record<string, number>, synergy: 0, lines: [] as string[] };
  let r = rng.next();
  for (const b of o.branches) {
    r -= b.p;
    if (r >= 0) continue;
    if (b.morale) {
      for (const p of st) {
        const before = p.morale;
        p.morale = clamp(p.morale + b.morale, 0, 100);
        sb.morale[p.id] = p.morale - before;
      }
      sb.lines.push(`남은 세트 동안 주전 사기 ${sg(b.morale)}`);
    }
    if (b.synergy) {
      const before = t.synergy;
      t.synergy = clamp(t.synergy + b.synergy, 0, 100);
      sb.synergy = t.synergy - before;
      sb.lines.push(`남은 세트 동안 팀 합 ${sg(b.synergy)}`);
    }
    break;
  }
  if (!sb.lines.length) sb.lines.push("별 변화는 없었습니다");
  ev.setBreak = sb;
  return sb.lines;
}

/** The goods boost from a highlight event: x1.5 demand for that player's goods while it lasts. */
export function goodsEventMul(s: GameState, featured: string | null): number {
  const g = s.ev?.goodsBoost;
  return g && featured === g.pid && s.day <= g.until ? 1.5 : 1;
}

/** Next season's sponsor deal: +3% once if the club turned down a shoot politely. */
export function sponsorEventMul(s: GameState): number {
  const team = s.ev?.memo.team ?? [];
  const i = team.findIndex((m) => m.tag === "스폰서호감");
  if (i < 0) return 1;
  team.splice(i, 1);
  return 1.03;
}

/** For checks and tests. */
export const EVENT_DEFS = DEFS.map((d) => ({ id: d.id, pol: d.pol, cls: d.cls }));

/**
 * Tests only (scripts/events-check.ts): put one event on screen whatever its conditions. Uses its own target
 * search when that finds one, else two of the user's players and stand-in data.
 */
export function forceEvent(s: GameState, data: GameData, id: string, rng: Rng): boolean {
  const d = BY_ID.get(id);
  if (!d) return false;
  const c = ctxFor(s, rng, data, d.id);
  const found = d.find ? d.find(c) : true;
  if (!found || (d.cls === "after" && !c.p && !d.team)) {
    const st = starters(c);
    const ros = roster(c);
    c.p = st[0] ?? ros[0] ?? null;
    c.q = st[1] ?? ros[1] ?? null;
    const bench = ros.find((x) => !isStarter(c, x));
    const stf = staffOf(c)[0];
    const champs = data.champions.map((x) => x.id);
    c.d = {
      ...c.d,
      staff: c.d.staff ?? stf?.id ?? "",
      fee: c.d.fee ?? 50000,
      club: c.d.club ?? s.intl[0],
      champ: c.d.champ ?? champs[0],
      sChamp: c.d.sChamp ?? champs[1],
      opp: c.d.opp ?? s.lck.find((x) => x !== s.user)!,
      team: c.d.team ?? s.lck.find((x) => x !== s.user)!,
      tier: c.d.tier ?? (rng.chance(0.5) ? "serious" : "mild"),
      k: c.d.k ?? 0,
      sr: c.d.sr ?? "none",
      ...(bench ? { bench: bench.id } : {}),
    };
    if ((id === "N7" || id === "M2") && !stf) return false;
  }
  fire(s, c, d);
  return true;
}
