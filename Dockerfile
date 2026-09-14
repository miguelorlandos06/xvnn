FROM node:20-alpine

# Instalar FFmpeg nativo completo
RUN apk add --no-cache ffmpeg

# Verificar que quedó instalado
RUN ffmpeg -version | head -n 1

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# Puerto estándar de Render
EXPOSE 10000

CMD ["node", "server.js"]