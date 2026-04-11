import axios from 'axios';

interface PetStats {
  INT: number;
  LUK: number;
  ATK: number;
  PRC: number;
}

interface SkillChip {
  id: string;
  promptModifier: string;
  statBonus: Partial<PetStats>;
}

export class OllamaBridge {
  private baseUrl = "http://localhost:11434/api/generate";

  async chat(userMessage: string, stats: PetStats, activeChips: SkillChip[]) {
    const chipModifiers = activeChips.map(c => c.promptModifier).join("\n");
    const systemPrompt = this.buildSoulPrompt(stats, chipModifiers);

    const payload = {
      model: "gemma4:31b",
      prompt: `System: ${systemPrompt}\n\nUser: ${userMessage}`,
      stream: false,
      options: {
        temperature: 0.7,
        num_ctx: 4096,
      }
    };

    const response = await axios.post(this.baseUrl, payload);
    return response.data.response;
  }

  private buildSoulPrompt(stats: PetStats, modifiers: string) {
    return `Role: Digital Mercenary Pet.
    Stats: INT:${stats.INT} | ATK:${stats.ATK} | PRC:${stats.PRC} | LUK:${stats.LUK}
    Active Chips: ${modifiers}
    Constraint: Never break character. You live in the OS.`;
  }
}
