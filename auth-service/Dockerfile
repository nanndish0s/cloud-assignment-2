FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache python3 make g++
RUN npm install --omit=dev
COPY . .
EXPOSE 3001
CMD ["node", "index.js"]
