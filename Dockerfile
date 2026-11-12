# Etapa 1: compilar React
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_UNIFI_API_BASE_URL=/api
ENV VITE_UNIFI_API_BASE_URL=$VITE_UNIFI_API_BASE_URL
RUN npm run build

# Etapa 2: servir los archivos estáticos
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80