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
COPY --from=build /app/dist /app/dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
EXPOSE 4300
CMD ["node", "dist/index.js"]
