FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /data/session
EXPOSE 3000

# Container-level liveness check. The app's /health endpoint intentionally
# checks the Node process only, so a temporary WhatsApp outage does not cause
# the host to kill a process that is already attempting a safe reconnect.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["npm", "start"]
