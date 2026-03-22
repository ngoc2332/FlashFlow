FROM node:20-alpine

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/order-api/package.json apps/order-api/package.json
COPY apps/outbox-publisher/package.json apps/outbox-publisher/package.json
COPY apps/payment-worker/package.json apps/payment-worker/package.json
COPY apps/inventory-worker/package.json apps/inventory-worker/package.json
COPY apps/order-status-updater/package.json apps/order-status-updater/package.json
COPY packages/common/package.json packages/common/package.json

RUN npm install

COPY apps/order-status-updater apps/order-status-updater
COPY packages/common packages/common

RUN npm run build -w @flashflow/common && npm run build -w @flashflow/order-status-updater

CMD ["npm", "run", "start:status-updater"]
