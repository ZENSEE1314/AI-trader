FROM node:20-slim

# better-sqlite3 needs python3 + make + g++ for native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Persistent data directory for SQLite (trades.db)
RUN mkdir -p /data

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "bot.js"]
