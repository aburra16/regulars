# The site as a container: the same build as the Pages deploy (deploy.yml), served by nginx.
# Built and pushed by .github/workflows/image.yml. The Node major is .nvmrc's (image.yml checks).
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM nginx:1.31-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 8080
