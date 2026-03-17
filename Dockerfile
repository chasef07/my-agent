FROM node:20-slim

# Install amd CLI (AdvancedMD) — prebuilt Linux binary
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/Data-Buddies-Solutions/advancedmd-token-management/releases/latest/download/amd-linux-amd64 \
       -o /usr/local/bin/amd \
    && chmod +x /usr/local/bin/amd

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

EXPOSE 3000
CMD ["npm", "start"]
