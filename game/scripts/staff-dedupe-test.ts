// One person, one staff record: an old save with the duplicated coaches (kkOma/KkOma, cvMax/CvMax, bon0/Bon0, the
// player-coach Bible) signed twice is cleaned up on load, and a new game never puts one person on two staff slots.
// Run: node scripts/run-ts.mjs scripts/staff-dedupe-test.ts
// OLD_STAFF=path runs the old-save part on the real staff.json from before the fix
// (git show 52ee9c2:game/public/data/staff.json) instead of on duplicates made from today's data.
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { autoAdvance, closeUserSeries, migrateSave, newGame, resolveEvent, userSeriesToday } from "../src/core/game";
import { fireStaffUser, hireStaffUser, joinTeam, staffAsk } from "../src/core/market";
import { ovr, salaryAsk } from "../src/core/player";
import { playQuickSeries } from "../src/core/quick";
import { Rng } from "../src/core/rng";
import { willTalkStaff } from "../src/core/staffNeg";
import type { GameState } from "../src/core/types";
import { ROLES } from "../src/data/types";
import type { StaffData } from "../src/data/types";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const parts = [j("champions.json"), j("players.json")] as const;
const rest = [j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json")] as const;
const data = assembleData("data", ...parts, j("staff.json"), ...rest);
let fails = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) fails++;
};

/** Every person once: no two staff ids equal but for case, no staff id that is also a player, one club per coach. */
function personCheck(s: GameState, label: string) {
  const keys = Object.keys(s.staff).map((id) => id.toLowerCase());
  check(new Set(keys).size === keys.length, `${label}: staff ids unique ignoring case (${keys.length})`);
  const players = new Set(Object.keys(s.players).map((id) => id.toLowerCase()));
  check(!keys.some((k) => players.has(k)), `${label}: no coach is also a player`);
  const seats = new Map<string, string[]>();
  for (const t of Object.values(s.teams)) for (const id of t.staff) seats.set(id, [...(seats.get(id) ?? []), t.id]);
  const twice = [...seats].filter(([, ts]) => ts.length > 1);
  check(!twice.length, `${label}: no coach on two clubs ${twice.map(([id, ts]) => `${id}@${ts.join("+")}`).join(" ")}`);
  const wrong = [...seats].filter(([id, ts]) => s.staff[id]?.team !== ts[0]);
  check(!wrong.length, `${label}: staff lists match each coach's club ${wrong.map(([id]) => id).join(" ")}`);
  const hc = Object.values(s.teams).filter((t) => t.staff.filter((id) => s.staff[id]?.role === "Head Coach").length > 1);
  check(!hc.length, `${label}: at most one head coach per club ${hc.map((t) => t.id).join(" ")}`);
}

// ---------- 1. the data ----------
const lower = data.staff.map((d) => d.id.toLowerCase());
check(new Set(lower).size === lower.length, `staff.json: ${data.staff.length} coaches, no id twice ignoring case`);
const kk = data.staff.find((d) => d.id === "kkOma");
check(!!kk && kk.role === "Head Coach", `kkOma is one head coach: ${kk?.role} ${kk?.record?.w}-${kk?.record?.l} seasons ${kk?.seasons}`);

/**
 * The staff data from before the fix: the real file when OLD_STAFF names it, otherwise the same duplicates made
 * from today's data (each of the three coaches a second time as a "Coach" under the other spelling, his record
 * split over the two records, and the player Bible as a coach too).
 */
function oldStaffJson(): { staff: StaffData[] } {
  if (process.env.OLD_STAFF) return JSON.parse(readFileSync(process.env.OLD_STAFF, "utf8"));
  const now = j("staff.json") as { staff: StaffData[] };
  const twins: Record<string, string> = { kkOma: "KkOma", cvMax: "CvMax", bon0: "Bon0" };
  const staff: StaffData[] = [];
  for (const d of now.staff) {
    const twin = twins[d.id];
    if (!twin) {
      staff.push(d);
      continue;
    }
    const rec = d.record ?? { w: 0, l: 0 };
    const part = { w: Math.floor(rec.w / 6), l: Math.floor(rec.l / 6) };
    staff.push({ ...d, record: { w: rec.w - part.w, l: rec.l - part.l } });
    staff.push({ ...d, id: twin, role: "Coach", fame: Math.min(d.fame, 28), titles: 0, record: part });
  }
  const coach = now.staff.find((d) => d.role === "Coach" && d.tier === 2)!;
  staff.push({ ...coach, id: "Bible", name: "Bible", realName: "", fame: 1, titles: 0, record: { w: 16, l: 41 } });
  return { staff };
}

// ---------- 2. an old save with the duplicates signed twice ----------
{
  const oldData = assembleData("data", ...parts, oldStaffJson(), ...rest);
  console.log(process.env.OLD_STAFF ? `(old staff data: ${process.env.OLD_STAFF})` : "(old staff data: duplicates made from today's staff.json)");
  const oldKk = oldData.staff.filter((d) => d.id.toLowerCase() === "kkoma");
  const sum = { w: oldKk.reduce((a, d) => a + (d.record?.w ?? 0), 0), l: oldKk.reduce((a, d) => a + (d.record?.l ?? 0), 0) };
  // only the real old file can show that the generator added the two records up: the made-up ones are a split of today's
  if (process.env.OLD_STAFF) check(oldKk.length === 2 && kk?.record?.w === sum.w && kk?.record?.l === sum.l, `kkOma's record is his two old records added up: ${sum.w}-${sum.l}`);
  const s = newGame(oldData, { team: "T1", difficulty: "normal", manager: "t", seed: 7 });
  const sign = (id: string, team: string) => {
    const st = s.staff[id];
    if (team === s.user) return hireStaffUser(s, st, staffAsk(st), 2, false).ok;
    st.team = team;
    st.contract = { salary: staffAsk(st), until: s.season + 1, signedDay: 0 };
    s.teams[team].staff.push(id);
    return true;
  };
  // the bug: kkOma as head coach and KkOma as coach of the user's club, cvMax and CvMax on two AI clubs
  const before = [sign("kkOma", "T1"), sign("KkOma", "T1"), sign("Bible", "T1"), sign("cvMax", "DK"), sign("CvMax", "GEN")];
  check(before.every(Boolean), `old data lets one person sign twice: T1 ${s.teams.T1.staff.join(",")} | DK ${s.teams["DK"].staff.join(",")} | GEN ${s.teams["GEN"].staff.join(",")}`);
  const userCvMax = willTalkStaff(s, s.staff.CvMax);
  check(!userCvMax.ok, `old data: CvMax at Gen.G refuses talks to the user (${userCvMax.msg})`);
  // also: Bon0 free, bon0 with the user mid-talks
  s.staff.bon0.talk = { season: s.season, affinity: 12, patience: 3 };
  const T1 = s.teams.T1;
  const cashBefore = T1.cash;
  const notes = migrateSave(s, data);
  console.log("notes:", notes);
  personCheck(s, "migrated save");
  check(T1.staff.includes("kkOma") && !T1.staff.includes("KkOma") && s.staff.kkOma.role === "Head Coach" && s.staff.kkOma.team === "T1",
    `kkOma stays T1 head coach, KkOma gone: T1 ${T1.staff.join(",")}`);
  check(!s.staff.KkOma && !s.staff.CvMax && !s.staff.Bon0 && !s.staff.Bible, "the duplicate records are gone");
  check(!T1.staff.includes("Bible") && !!s.players.Bible, "Bible leaves the staff, stays a player");
  check(s.staff.cvMax.team === "DK" && !s.teams["GEN"].staff.includes("CvMax"), `cvMax stays with DK, Gen.G loses CvMax: GEN ${s.teams["GEN"].staff.join(",")}`);
  check(s.staff.kkOma.record.w === sum.w && s.staff.kkOma.record.l === sum.l && !!s.staff.kkOma.contract, `kkOma gets the merged record ${s.staff.kkOma.record.w}-${s.staff.kkOma.record.l}, keeps his contract`);
  check(s.staff.bon0.talk?.affinity === 12 && !s.staff.bon0.team, "bon0 keeps the user's talks");
  check(notes.length === 2 && notes.every((n) => n.includes("코칭스태프에서 뺐습니다")), "the user hears about the two coaches who left");
  check(T1.cash === cashBefore, "no money moves");
  const again = migrateSave(s, data);
  check(!again.length, "a second load changes nothing");

  // the user's coach KkOma while an AI club has head coach kkOma: the user's coach stays
  const s2 = newGame(oldData, { team: "KT", difficulty: "normal", manager: "t", seed: 8 });
  s2.staff.KkOma.team = "KT"; s2.staff.KkOma.contract = { salary: 5000, until: s2.season + 1, signedDay: 0 }; s2.teams.KT.staff.push("KkOma");
  s2.staff.kkOma.team = "T1"; s2.staff.kkOma.contract = { salary: 30000, until: s2.season + 1, signedDay: 0 }; s2.teams.T1.staff.push("kkOma");
  s2.staff.Bon0.talk = { season: s2.season, affinity: 7, patience: 2 }; // talks held with the record that goes
  migrateSave(s2, data);
  personCheck(s2, "user coach vs AI head coach");
  check(s2.teams.KT.staff.includes("kkOma") && s2.staff.kkOma.role === "Coach" && s2.staff.kkOma.contract?.salary === 5000 && !s2.teams.T1.staff.length,
    `the user's coach stays a coach on his contract, T1 loses its head coach: KT ${s2.teams.KT.staff.join(",")} T1 ${s2.teams.T1.staff.join(",")}`);
  check(s2.staff.bon0.talk?.affinity === 7, "talks held with the dropped record carry over to the one that stays");
  // he is a coach only for that contract: a head coach again when it is over
  check(s2.staff.kkOma.ownRole === "Head Coach", `the coach kkOma remembers his own role (${s2.staff.kkOma.ownRole})`);
  check(!migrateSave(s2, data).length && s2.staff.kkOma.role === "Coach", "a second load leaves him a coach while the contract runs");
  fireStaffUser(s2, s2.staff.kkOma);
  check(s2.staff.kkOma.role === "Head Coach" && !s2.staff.kkOma.team && !s2.staff.kkOma.ownRole && !s2.teams.KT.staff.includes("kkOma"),
    `let go, kkOma is a free head coach again (${s2.staff.kkOma.role})`);

  // a save the first version of this cleanup already went through: the kept "Coach" has no ownRole yet
  const s3 = newGame(data, { team: "KT", difficulty: "normal", manager: "t", seed: 9 });
  s3.staff.kkOma.role = "Coach"; // a free agent
  s3.staff.cvMax.role = "Coach"; s3.staff.cvMax.team = "DK"; s3.staff.cvMax.contract = { salary: 6000, until: s3.season, signedDay: 0 }; s3.teams["DK"].staff.push("cvMax");
  migrateSave(s3, data);
  check(s3.staff.kkOma.role === "Head Coach", "already cleaned save: the free agent is a head coach again on load");
  check(s3.staff.cvMax.role === "Coach" && s3.staff.cvMax.ownRole === "Head Coach", "already cleaned save: the signed one keeps coaching until his contract ends");
}

// ---------- 3. a new game: the user can't sign one person twice, and the AI never does ----------
const s = newGame(data, { team: "T1", difficulty: "normal", manager: "t", seed: 11 });
check(hireStaffUser(s, s.staff.kkOma, staffAsk(s.staff.kkOma), 2, false).ok, "user signs kkOma as head coach");
check(!s.staff.KkOma, "there is no second kkOma to sign as a coach");
const again = willTalkStaff(s, s.staff.kkOma);
check(!again.ok, `kkOma again: ${again.msg}`);
const pool = Object.values(s.players).filter((p) => !p.team && p.origin === "real").sort((a, b) => ovr(b) - ovr(a));
for (const r of ROLES) {
  const p = pool.find((x) => x.role === r && !x.team)!;
  joinTeam(s, p, "T1", salaryAsk(p, s.season), 2);
}
// a head coach working as the user's coach until this season ends (what the old-save cleanup leaves behind)
const temp = s.staff.cvMax;
temp.role = "Coach"; temp.ownRole = "Head Coach"; temp.team = "T1"; temp.contract = { salary: 6000, until: s.season, signedDay: 0 };
s.teams.T1.staff.push("cvMax");
// a season and the next stove league (contracts end, AI clubs hire again), checked every 30th stop (match or event)
const rng = new Rng(2);
let bad = 0;
let newSeasonDay = 0;
for (let i = 0; i < 900 && !(newSeasonDay && s.day > newSeasonDay + 30); i++) {
  if (s.season > 2027 && !newSeasonDay) newSeasonDay = s.day;
  autoAdvance(s, data, "match");
  if (s.events.length) resolveEvent(s, s.events[0].id, 0);
  s.cutscenes.length = 0;
  const sr = userSeriesToday(s);
  if (sr) { playQuickSeries(s, data, sr, rng); closeUserSeries(s, data, sr); }
  if (i % 30 === 0) {
    const before = fails;
    personCheck(s, `day ${s.day} ${s.season}`);
    if (fails > before) bad++;
  }
}
check(s.season === 2028, `played into the 2028 stove league (day ${s.day}), ${bad} bad checks`);
check(temp.role === "Head Coach" && !temp.ownRole && temp.team !== "T1", `his contract over, cvMax is a head coach again (${temp.role}, ${temp.team ?? "free"})`);
personCheck(s, `after a season (day ${s.day}, ${s.season})`);
const hcs = s.lck.map((id) => `${s.teams[id].short}:${s.teams[id].staff.map((x) => s.staff[x]?.name).join("/") || "-"}`);
console.log("staff:", hcs.join(" | "));
console.log(fails ? `${fails} FAILED` : "all passed");
if (fails) process.exitCode = 1;
