# @AskApai mention-reply bot — production image
FROM node:20-alpine

WORKDIR /app

# Install prod deps only (axios + dotenv). Uses the committed lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
# Persist since_id + usage across restarts — mount a volume here.
ENV BOT_DATA_DIR=/data
VOLUME ["/data"]

# Safe by default: score + log, never post, until you set DRY_RUN=false.
ENV DRY_RUN=true

# Long-running poller. For cron/one-shot hosts, override CMD with: node src/index.js scan
CMD ["node", "src/index.js", "loop"]
