FROM node:20-alpine

WORKDIR /app

# Instalar dependencias primero (aprovecha cache de Docker)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copiar código fuente
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
