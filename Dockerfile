# VEEMENZ — production image
FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY --chown=node:node . .

RUN mkdir -p /data /data/backups \
    && chown -R node:node /data /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/paint_inventory.db
ENV BACKUP_DIR=/data/backups
ENV TRUST_PROXY=1

USER node

EXPOSE 3000
CMD ["node", "server.js"]
