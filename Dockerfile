# Stage 1: Build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build backend TypeScript
FROM node:20-alpine AS backend-build
WORKDIR /build/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Stage 3: Production runtime
FROM node:20-alpine
WORKDIR /app

# Copy compiled backend
COPY --from=backend-build /build/backend/dist ./backend/dist
COPY --from=backend-build /build/backend/package*.json ./backend/

# Install production dependencies only
RUN cd backend && npm ci --omit=dev

# Copy built frontend assets
COPY --from=frontend-build /build/frontend/dist ./frontend/dist

# Create persistent directories (will be overridden by volumes)
RUN mkdir -p database data/uploads

EXPOSE 3001

CMD ["node", "backend/dist/index.js"]
