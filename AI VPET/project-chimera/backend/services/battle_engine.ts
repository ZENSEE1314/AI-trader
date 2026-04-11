import { PetStats } from './ollama_client';

interface Combatant {
  name: string;
  stats: PetStats;
  tacticSentence: string;
  tacticScore: number;
}

export function calculateDamage(attacker: Combatant, defender: Combatant) {
  const attackPower = attacker.stats.ATK * attacker.tacticScore;
  const defensePower = defender.stats.PRC * defender.tacticScore;

  const rawDamage = attackPower - defensePower;
  const finalDamage = Math.max(0, rawDamage);

  const luckRoll = Math.random() * 100;
  const isCritical = luckRoll < attacker.stats.LUK;
  const totalDamage = isCritical ? finalDamage * 1.5 : finalDamage;

  return {
    damage: totalDamage,
    isCritical: isCritical,
    log: `${attacker.name} strikes for ${totalDamage.toFixed(1)} damage! ${isCritical ? 'CRITICAL HIT!' : ''}`
  };
}
