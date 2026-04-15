#!/bin/bash
# Ollama startup: inject cloud SSH key, pull model, then serve

echo "=== Starting Ollama Server ==="

# Inject SSH key for cloud-routed models (gemma4:31b-cloud, etc.)
if [ -n "$OLLAMA_SSH_KEY_B64" ]; then
  mkdir -p /root/.ollama
  echo "$OLLAMA_SSH_KEY_B64" | base64 -d > /root/.ollama/id_ed25519
  chmod 600 /root/.ollama/id_ed25519
  echo "SSH key injected for Ollama cloud auth"
fi

if [ -n "$OLLAMA_SSH_PUB" ]; then
  echo "$OLLAMA_SSH_PUB" > /root/.ollama/id_ed25519.pub
  chmod 644 /root/.ollama/id_ed25519.pub
fi

# Start Ollama in background
ollama serve &
SERVER_PID=$!

# Wait for server to be ready
echo "Waiting for Ollama to start..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "Ollama is ready!"
    break
  fi
  sleep 2
done

# Pull the configured model (cloud-routed models need SSH key above)
MODEL=${OLLAMA_MODEL:-gemma4:31b-cloud}
echo "Pulling model: $MODEL"
ollama pull "$MODEL" 2>&1
echo "Model $MODEL ready!"

# List available models
ollama list

# Keep server running
wait $SERVER_PID
