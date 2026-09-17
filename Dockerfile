FROM node:20-alpine

# FFmpeg 6 (compatible con fluent-ffmpeg)
RUN apk add --no-cache ffmpeg=6.1.1-r0 || apk add --no-cache ffmpeg

# Verificar versión
RUN ffmpeg -version | head -n 1

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 10000
CMD ["node", "server.js"]