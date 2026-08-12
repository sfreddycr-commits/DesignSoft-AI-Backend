FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN corepack enable
RUN apk add --no-cache python3 make g++ && \
    cd $(find /app/node_modules/ -name "better-sqlite3" -type d | head -1) && \
    npx node-gyp rebuild
COPY --from=build /app/dist /app/dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
EXPOSE 4400
CMD ["node", "dist/index.js"]
