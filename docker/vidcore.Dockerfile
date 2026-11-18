FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .
RUN npm run build:web
ENV PORT=8789
EXPOSE 8789
CMD ["npx", "tsx", "src/server.ts"]
