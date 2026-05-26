FROM node:20-alpine

WORKDIR /app

# Install deps first (layer-cache friendly)
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY server.js ./
COPY public/   ./public/

# config.json is bind-mounted at runtime so edits persist on the host
# (see docker-compose.yml volumes section)

EXPOSE 3200

CMD ["node", "server.js"]
