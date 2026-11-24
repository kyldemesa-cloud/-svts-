FROM node:20-slim
WORKDIR /app

# better-sqlite3 is a native module; install build tools for npm install if prebuilt binaries are unavailable
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV DB_PATH=/data/svts.sqlite
EXPOSE 3000
CMD ["node", "server.js"]
