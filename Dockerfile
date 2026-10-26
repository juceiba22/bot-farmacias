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

# Base de datos, adjuntos y catálogo viven acá: montá un volumen en /app/data.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
