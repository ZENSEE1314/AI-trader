const axios = require('axios');

class AICloudGateway {
  // Using a Cloud Provider (Groq/Together) for mobile accessibility
  private apiKey = process.env.AI_API_KEY;
  private baseUrl = "https://api.groq.com/openai/v1/chat/completions";

  async generateResponse(userMessage, userProfile, activeChips) {
    const chipModifiers = activeChips.map(c => c.promptModifier).join("\n");
    const systemPrompt = this.buildSoulPrompt(userProfile, chipModifiers);

    const response = await axios.post(this.baseUrl, {
      model: "gemma2-9b", // High speed for mobile
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      temperature: 0.7
    }, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    return response.data.choices[0].message.content;
  }

  private buildSoulPrompt(profile, modifiers) {
    return `Role: Digital Mercenary Pet.
    Current Stats: INT:${profile.pet.stats.INT} | ATK:${profile.pet.stats.ATK} | PRC:${profile.pet.stats.PRC} | LUK:${profile.pet.stats.LUK}
    Active Mods: ${modifiers}
    Identity: You are a mercenary hired by the user. Be witty and competitive.`;
  }
}

module.exports = new AICloudGateway();
