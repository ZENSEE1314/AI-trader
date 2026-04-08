FROM node:20-slim

# Install Python 3 + pip for Kronos AI predictions
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv wget \
    && rm -rf /var/lib/apt/lists/*

# Install CPU-only PyTorch first (saves ~1.5GB vs full CUDA build)
RUN pip3 install --no-cache-dir --break-system-packages \
    torch --index-url https://download.pytorch.org/whl/cpu

# Install remaining Kronos dependencies
RUN pip3 install --no-cache-dir --break-system-packages \
    numpy pandas tqdm einops huggingface_hub safetensors

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create non-root user
RUN groupadd -g 1001 nodejs
RUN useradd -u 1001 -g nodejs -s /bin/sh nodejs
USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

EXPOSE 3000
CMD ["npm", "start"]
