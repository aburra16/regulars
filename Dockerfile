# The site as a container: the same build as the Pages deploy (deploy.yml), served by nginx.
# Built and pushed by .github/workflows/image.yml. The Node major is .nvmrc's (image.yml checks).
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# The pages a shared link opens, one per place, chain and fixed page, read from the hub's list
# (tools/share-pages.ts). It fails without an answer from the hub or with too few places, and with it
# the build: no image without its pages. PAGES_STAMP changes on every run (image.yml passes the run
# id), so the layer cache never ships a previous build's list.
ARG PAGES_STAMP=unset
RUN echo "share pages, build ${PAGES_STAMP}" && npm run share-pages

FROM nginx:1.31-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 8080
