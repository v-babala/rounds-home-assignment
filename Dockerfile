FROM node:24-bookworm-slim AS dev
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build -w @rounds/shared && npm run build -w @rounds/api
CMD ["npm", "run", "dev"]
