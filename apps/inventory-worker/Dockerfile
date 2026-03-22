FROM node:20-alpine

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/order-api/package.json apps/order-api/package.json
COPY apps/outbox-publisher/package.json apps/outbox-publisher/package.json
COPY apps/payment-worker/package.json apps/payment-worker/package.json
COPY apps/inventory-worker/package.json apps/inventory-worker/package.json
COPY packages/common/package.json packages/common/package.json

RUN npm install

COPY apps/inventory-worker apps/inventory-worker
COPY packages/common packages/common

RUN npm run build -w @flashflow/common && npm run build -w @flashflow/inventory-worker

CMD ["npm", "run", "start:inventory"]
