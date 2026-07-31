# --- Build-Stage: kompiliert better-sqlite3 (native Abhängigkeit) ---
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install --omit=dev
COPY . .

# --- Runtime-Stage: schlankes Image ohne Build-Tools ---
FROM node:20-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app /app
RUN mkdir -p /app/data && chown -R app:app /app
USER app
ENV NODE_ENV=production
ENV DB_PATH=/app/data/data.db
EXPOSE 3000
CMD ["node", "server.js"]
