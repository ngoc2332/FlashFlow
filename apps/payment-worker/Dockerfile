FROM node:20-alpine

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/order-api/package.json apps/order-api/package.json
COPY apps/outbox-publisher/package.json apps/outbox-publisher/package.json
COPY apps/payment-worker/package.json apps/payment-worker/package.json
COPY packages/common/package.json packages/common/package.json

RUN npm install

COPY apps/payment-worker apps/payment-worker
COPY packages/common packages/common

RUN npm run build -w @flashflow/common && npm run build -w @flashflow/payment-worker

CMD ["npm", "run", "start:payment"]
