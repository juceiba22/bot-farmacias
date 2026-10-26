# Node 24 corre TypeScript directo y trae SQLite: no hace falta compilar ni instalar dependencias.
FROM node:24-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app

COPY package.json ./
COPY pharmacy.json ./
COPY src ./src
COPY public ./public
COPY seed ./seed

# Base de datos, adjuntos y catálogo viven en /app/data: montá un volumen de Railway ahí.
# (Railway rechaza la instrucción VOLUME del Dockerfile y ya hace el healthcheck con railway.json.)
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
