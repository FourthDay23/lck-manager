// Does signing, transfers and payday actually move the user's cash?
import { readFileSync, existsSync } from "node:fs";
import { assembleData } from "../src/data/load";
import { advanceDay, newGame } from "../src/core/game";
import { completeUserSigning, hireStaffUser, clubDemand, staffAsk } from "../src/core/market";
import { salaryAsk } from "../src/core/player";
import { money, fmtDate } from "../src/core/format";

const j = (f: string) => (existsSync(`public/data/${f}`) ? JSON.parse(readFileSync(`public/data/${f}`, "utf8")) : null);
const data = assembleData("data", j("champions.json"), j("players.json"), j("staff.json"), j("teams.json"), j("intl.json"), j("meta.json"), j("heatmap.json"));
const s = newGame(data, { team: "KRX", difficulty: "normal", manager: "t", seed: 1 });
const me = s.teams[s.user];
const log = (label: string) => console.log(`${fmtDate(s.day)} | ${label.padEnd(28)} | cash ${money(me.cash)}`);
log("start");
const fa = Object.values(s.players).filter((p) => !p.team && p.origin === "real").sort((a, b) => b.fame - a.fame);
const a = fa[3], b = fa[8];
completeUserSigning(s, a, "sign", { salary: salaryAsk(a, s.season), years: 2, bonus: 5000, starter: true }, 0);
log(`sign ${a.name} bonus 5000, salary ${money(salaryAsk(a, s.season))}`);
completeUserSigning(s, b, "sign", { salary: salaryAsk(b, s.season), years: 1, bonus: 0, starter: false }, 0);
log(`sign ${b.name} no bonus`);
// a contracted player (Faker) with a transfer fee
const faker = Object.values(s.players).find((p) => p.name === "Faker")!;
const fee = clubDemand(s, faker);
// completeUserSigning(s, faker, "transfer", { salary: 90000, years: 2, bonus: 0, starter: true }, fee);
log(`transfer Faker fee ${money(fee)}`);
const hc = Object.values(s.staff).find((x) => x.role === "Head Coach" && !x.team)!;
console.log(hireStaffUser(s, hc, staffAsk(hc), 2).msg);
log(`hire ${hc.name}`);
console.log("roster", me.roster.map((id) => `${s.players[id].name} ${money(s.players[id].contract!.salary)}`).join(", "));
for (let i = 0; i < 70; i++) {
  const before = me.cash;
  advanceDay(s, data);
  s.cutscenes.length = 0;
  if (Math.abs(me.cash - before) > 0) log(`day change ${money(me.cash - before)}`);
}
console.log("ledger", JSON.stringify(s.ledger, null, 0));
