FROM node:22-slim

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY backend/src/lib/sourceDocuments.ts /app/backend/src/lib/
COPY backend/src/lib/chat/types.ts /app/backend/src/lib/chat/
COPY word-addin/src /app/word-addin/src

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
