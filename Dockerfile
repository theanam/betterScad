# syntax=docker/dockerfile:1

# ----------------------------------------------------------------------------
# Build stage: compile the static site with the official Node LTS image.
# Runs the same commands as the README "Quick start": npm install && npm run build.
# ----------------------------------------------------------------------------
FROM node:24-alpine AS build

WORKDIR /app

# Optional: full origin (e.g. https://cad.example.com) the site will be served
# under. When set, the build points canonical/Open Graph/sitemap/robots at it.
# When unset, the published CNAME is excluded from the build context (see
# .dockerignore), so the image serves no absolute SEO tags and does not declare
# itself a duplicate of betterscad.org.
ARG BETTERSCAD_SITE_URL=
ENV BETTERSCAD_SITE_URL=$BETTERSCAD_SITE_URL

# Copy manifests first so dependency install is cached across source-only changes.
COPY package.json package-lock.json ./
COPY packages/engine/package.json ./packages/engine/
COPY packages/app/package.json ./packages/app/
COPY packages/cli/package.json ./packages/cli/

RUN npm install

# Bring in the rest of the source and build the static site.
COPY . .
RUN npm run build

# ----------------------------------------------------------------------------
# Run stage: serve the built static files with the official NGINX image.
# The app is a single-page build with relative asset paths, so the stock
# NGINX config serving the files at the web root is all that is needed.
# ----------------------------------------------------------------------------
FROM nginx:latest AS run

COPY --from=build /app/packages/app/dist /usr/share/nginx/html

EXPOSE 80
