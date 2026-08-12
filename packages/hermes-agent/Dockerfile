FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY packages/hermes-agent/package.json ./
RUN npm install
COPY packages/hermes-agent/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache curl
RUN corepack enable
COPY --from=build /app/dist /app/dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
RUN mkdir -p /data/memory
VOLUME ["/data/memory"]
EXPOSE 5000
CMD ["node", "dist/index.js"]
