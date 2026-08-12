FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY packages/whatsapp-worker/package.json ./
RUN npm install
COPY packages/whatsapp-worker/ ./
RUN npm run build
RUN echo "=== Verifying dist ===" && ls -la dist/ && ls -la dist/transports/ 2>/dev/null || echo "NO transports dir"

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache curl
RUN corepack enable
COPY --from=build /app/dist /app/dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
RUN mkdir -p /data/whatsapp-session
VOLUME ["/data/whatsapp-session"]
EXPOSE 4500
CMD ["node", "dist/index.js"]
