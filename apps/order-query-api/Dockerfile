FROM node:20-alpine

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/order-api/package.json apps/order-api/package.json
COPY apps/outbox-publisher/package.json apps/outbox-publisher/package.json
COPY apps/payment-worker/package.json apps/payment-worker/package.json
COPY apps/inventory-worker/package.json apps/inventory-worker/package.json
COPY apps/order-status-updater/package.json apps/order-status-updater/package.json
COPY apps/order-query-api/package.json apps/order-query-api/package.json
COPY packages/common/package.json packages/common/package.json

RUN npm install

COPY apps/order-query-api apps/order-query-api
COPY packages/common packages/common

RUN npm run build -w @flashflow/common && npm run build -w @flashflow/order-query-api

EXPOSE 3001

CMD ["npm", "run", "start:order-query-api"]
