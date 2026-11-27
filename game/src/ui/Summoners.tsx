// A player's two summoner spells in the match HUD, the way a broadcast shows them: the icon, greyed out with the
// seconds left while it is on cooldown. The pair is the one that champion takes in that role in the LCK
// (match/summoners.ts), and the cooldowns are the ones the engine plays with.
import type { Engine, Unit } from "../match/engine";
import { SUMMONER_ICON, SUMMONER_KO, slots } from "../match/summoners";
import { spellImg } from "../data/load";
import { D } from "../store";
import "./summoners.css";

export function SummonerSpells({ e, u }: { e: Engine; u: Unit }) {
  const ver = D().ddVersion;
  return (
    <div class="sum-pair">
      {slots(e, u).map((s) => {
        const left = Math.ceil(s.left);
        const state = s.busy ? "시전 중" : left > 0 ? `${left}초 뒤 사용 가능` : "사용 가능";
        return (
          <span class={`sum ${left > 0 ? "cd" : ""} ${s.busy ? "busy" : ""}`} title={`${SUMMONER_KO[s.name]} · ${state}`}>
            <img src={spellImg(ver, SUMMONER_ICON[s.name])} alt="" />
            {left > 0 && !s.busy && <b>{left}</b>}
          </span>
        );
      })}
    </div>
  );
}
