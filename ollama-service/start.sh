#!/bin/bash
# Start Ollama server in background, pull model, then keep serving

echo "=== Starting Ollama Server ==="

# Start Ollama in background
ollama serve &
OLLAMA_PID=$!

# Wait for Ollama to be ready
echo "Waiting for Ollama to start..."
for i in $(seq 1 30); do
  if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "Ollama is ready!"
    break
  fi
  sleep 2
done

# Pull the model (uses OLLAMA_MODEL env var, defaults to gemma3:4b)
MODEL=${OLLAMA_MODEL:-gemma3:4b}
echo "Pulling model: $MODEL"
ollama pull "$MODEL"
echo "Model $MODEL ready!"

# Keep the server running
wait $OLLAMA_PID
