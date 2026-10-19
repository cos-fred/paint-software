# VEEMENZ — production image
FROM node:20-slim

# Build tools for better-sqlite3 (used only if a prebuilt binary isn't available)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# Data directory for the persistent volume
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/paint_inventory.db
ENV BACKUP_DIR=/data/backups

EXPOSE 3000
CMD ["npm", "start"]
