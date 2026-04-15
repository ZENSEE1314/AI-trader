// ============================================================
// HNSW-Lite — Hierarchical Navigable Small World vector index
// Transpiled from ruflo v3/@claude-flow/memory/src/hnsw-lite.ts
//
// Fast approximate nearest-neighbor search for market pattern
// matching. Sub-millisecond queries on thousands of patterns.
// ============================================================

'use strict';

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

class HnswLite {
  constructor(dimensions, m = 16, efConstruction = 100, metric = 'cosine') {
    this.vectors = new Map();
    this.neighbors = new Map();
    this.dimensions = dimensions;
    this.maxNeighbors = m;
    this.efConstruction = efConstruction;
    this.metric = metric;
  }

  get size() {
    return this.vectors.size;
  }

  add(id, vector) {
    this.vectors.set(id, vector);

    if (this.vectors.size === 1) {
      this.neighbors.set(id, new Set());
      return;
    }

    const nearest = this._findNearest(vector, this.maxNeighbors);
    const neighborSet = new Set();

    for (const n of nearest) {
      neighborSet.add(n.id);
      const nNeighbors = this.neighbors.get(n.id);
      if (nNeighbors) {
        nNeighbors.add(id);
        if (nNeighbors.size > this.maxNeighbors * 2) {
          this._pruneNeighbors(n.id);
        }
      }
    }

    this.neighbors.set(id, neighborSet);
  }

  remove(id) {
    this.vectors.delete(id);
    const myNeighbors = this.neighbors.get(id);
    if (myNeighbors) {
      for (const nId of myNeighbors) {
        const ns = this.neighbors.get(nId);
        if (ns) ns.delete(id);
      }
    }
    this.neighbors.delete(id);
  }

  search(query, k, threshold) {
    if (this.vectors.size === 0) return [];
    if (this.vectors.size <= k * 2) {
      return this._bruteForce(query, k, threshold);
    }

    const visited = new Set();
    const candidates = [];

    let entryId;
    let bestScore = -1;
    for (const [id] of this.vectors) {
      const score = this._similarity(query, this.vectors.get(id));
      if (score > bestScore) {
        bestScore = score;
        entryId = id;
      }
      if (visited.size >= Math.min(this.efConstruction, this.vectors.size)) break;
      visited.add(id);
      candidates.push({ id, score });
    }

    if (entryId) {
      const queue = [entryId];
      let idx = 0;

      while (idx < queue.length && visited.size < this.efConstruction * 2) {
        const currentId = queue[idx++];
        const currentNeighbors = this.neighbors.get(currentId);
        if (!currentNeighbors) continue;

        for (const nId of currentNeighbors) {
          if (visited.has(nId)) continue;
          visited.add(nId);

          const vec = this.vectors.get(nId);
          if (!vec) continue;

          const score = this._similarity(query, vec);
          candidates.push({ id: nId, score });
          queue.push(nId);
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    let filtered = candidates;
    if (threshold !== undefined) {
      filtered = filtered.filter(c => c.score >= threshold);
    }

    return filtered.slice(0, k);
  }

  _bruteForce(query, k, threshold) {
    const results = [];
    for (const [id, vec] of this.vectors) {
      const score = this._similarity(query, vec);
      if (threshold !== undefined && score < threshold) continue;
      results.push({ id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  _findNearest(query, k) {
    return this._bruteForce(query, k);
  }

  _pruneNeighbors(id) {
    const myNeighbors = this.neighbors.get(id);
    if (!myNeighbors) return;

    const vec = this.vectors.get(id);
    if (!vec) return;

    const scored = [];
    for (const nId of myNeighbors) {
      const nVec = this.vectors.get(nId);
      if (!nVec) continue;
      scored.push({ id: nId, score: this._similarity(vec, nVec) });
    }

    scored.sort((a, b) => b.score - a.score);
    const keep = new Set(scored.slice(0, this.maxNeighbors).map(s => s.id));

    for (const nId of myNeighbors) {
      if (!keep.has(nId)) myNeighbors.delete(nId);
    }
  }

  _similarity(a, b) {
    if (this.metric === 'dot') return dotProduct(a, b);
    if (this.metric === 'euclidean') return 1 / (1 + euclideanDistance(a, b));
    return cosineSimilarity(a, b);
  }

  toJSON() {
    const entries = [];
    for (const [id, vec] of this.vectors) {
      entries.push({ id, vec: Array.from(vec) });
    }
    return { dimensions: this.dimensions, metric: this.metric, entries };
  }

  static fromJSON(json) {
    const idx = new HnswLite(json.dimensions, 16, 100, json.metric || 'cosine');
    for (const entry of json.entries || []) {
      idx.add(entry.id, new Float32Array(entry.vec));
    }
    return idx;
  }
}

module.exports = { HnswLite, cosineSimilarity, dotProduct, euclideanDistance };
