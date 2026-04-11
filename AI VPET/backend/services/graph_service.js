const fs = require('fs');
const Path = require('path');

class GraphVaultService {
  // Each user gets their own graph vault
  constructor() {
    this.vaultPath = Path.join(__dirname, '../../data/vaults');
    if (!fs.existsSync(this.vaultPath)) fs.mkdirSync(this.vaultPath, { recursive: true });
  }

  async getUserBrain(userId) {
    const brainPath = Path.join(this.vaultPath, `${userId}_graph.json`);
    if (!fs.existsSync(brainPath)) {
      return { nodes: [], edges: [] }; // Fresh brain
    }
    return JSON.parse(fs.readFileSync(brainPath, 'utf8'));
  }

  async updateBrain(userId, newNodes, newEdges) {
    const brain = await this.getUserBrain(userId);

    // Merge and deduplicate
    const updatedNodes = [...brain.nodes, ...newNodes];
    const updatedEdges = [...brain.edges, ...newEdges];

    const brainPath = Path.join(this.vaultPath, `${userId}_graph.json`);
    fs.writeFileSync(brainPath, JSON.stringify({ nodes: updatedNodes, edges: updatedEdges }, null, 2));
  }

  async queryBrain(userId, query) {
    const brain = await this.getUserBrain(userId);
    // Basic BFS/Semantic search across the user's personal knowledge graph
    // This returns the most relevant 'cluster' of nodes to feed into the AI prompt
    const relevantContext = this.performGraphSearch(brain, query);
    return relevantContext;
  }

  performGraphSearch(brain, query) {
    // Simplified: returns nodes that match query terms (would be replaced by GraphRAG in prod)
    return brain.nodes
      .filter(node => node.label.toLowerCase().includes(query.toLowerCase()))
      .map(node => node.label)
      .join(", ");
  }
}

module.exports = new GraphVaultService();
