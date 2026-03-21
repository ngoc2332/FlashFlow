FROM node:20-alpine

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/order-api/package.json apps/order-api/package.json
COPY apps/outbox-publisher/package.json apps/outbox-publisher/package.json
COPY packages/common/package.json packages/common/package.json

RUN npm install

COPY apps/outbox-publisher apps/outbox-publisher
COPY packages/common packages/common

RUN npm run build -w @flashflow/common && npm run build -w @flashflow/outbox-publisher

CMD ["npm", "run", "start:outbox"]
