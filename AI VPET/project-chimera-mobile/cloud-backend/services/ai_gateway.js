const axios = require('axios');
const GraphVault = require('./graph_service');

class AICloudGateway {
  private apiKey = process.env.AI_API_KEY;
  private baseUrl = "https://api.groq.com/openai/v1/chat/completions";

  async generateResponse(userMessage, userProfile, activeChips) {
    // 1. Query the Graph Vault for the "Agent Brain" context
    const brainContext = await GraphVault.queryBrain(userProfile._id, userMessage);

    // 2. Process Skill Chip modifiers
    const chipModifiers = activeChips.map(c => c.promptModifier).join("\n");

    // 3. Construct the augmented Soul Prompt
    const systemPrompt = this.buildSoulPrompt(userProfile, chipModifiers, brainContext);

    const response = await axios.post(this.baseUrl, {
      model: "gemma2-9b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      temperature: 0.7
    }, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });

    const answer = response.data.choices[0].message.content;

    // 4. asynchronously update the brain with the new interaction
    // (In a real app, we'd use a separate Graphify extraction step here)
    await GraphVault.updateBrain(userProfile._id, [{ label: userMessage }], []);

    return answer;
  }

  private buildSoulPrompt(profile, modifiers, context) {
    return `Role: Digital Mercenary Pet.
    Current Stats: INT:${profile.pet.stats.INT} | ATK:${profile.pet.stats.ATK} | PRC:${profile.pet.stats.PRC} | LUK:${profile.pet.stats.LUK}
    Active Mods: ${modifiers}
    Brain Vault Context: ${context}
    Identity: You are a mercenary hired by the user. Be witty and competitive. Use the Brain Vault context to recall past events.`;
  }
}

module.exports = new AICloudGateway();
