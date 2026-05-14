# backend/Dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY src/ ./src/

# Create logs directory
RUN mkdir -p logs

# Run migrations then start
CMD ["sh", "-c", "node src/models/migrate.js && node src/index.js"]

EXPOSE 4000
