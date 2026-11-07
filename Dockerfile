# One Take as a web app, in two images. See "Running in Docker" in the README.
#
# The server (default): the editor in the browser, files and export on the server.
#   Build:  docker build -t one-take .
#   Run:    docker run -p 8080:8080 -v ~/OneTake:/data -v one-take-config:/config one-take
#
# Browser only: the server just hands out the page; files, export and recording stay in the browser.
#   Build:  docker build --target browser -t one-take-browser .
#   Run:    docker run -p 8080:8080 one-take-browser

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Electron is only needed for the desktop app; skipping its download keeps the build quick.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web && npx vite build --mode browser

# Nothing but static files and a small Node server, so the smallest Node image does.
FROM node:24-alpine AS browser
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/dist/server/static.cjs dist/server/
COPY --from=build /app/dist/browser dist/browser
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server/static.cjs"]

FROM node:24-bookworm-slim AS server
WORKDIR /app
ENV NODE_ENV=production \
    ONETAKE_DATA_DIR=/data \
    ONETAKE_CONFIG_DIR=/config \
    PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/dist/server dist/server
COPY --from=build /app/dist/web dist/web
# ffmpeg-static holds the ffmpeg binary downloaded for this platform during npm ci.
COPY --from=build /app/node_modules/ffmpeg-static node_modules/ffmpeg-static
RUN mkdir -p /data /config && chown node:node /data /config
USER node
VOLUME ["/data", "/config"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server/server.cjs"]
