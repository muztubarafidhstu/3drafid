# One shop = one container. Data (products, orders, photos, password) lives in /data, so keep that folder.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN mkdir -p /data /site && chown -R node:node /data /site /app
USER node
ENV PORT=3000 HOST=0.0.0.0 DATA_DIR=/data DIST_DIR=/site TRUST_PROXY=1 COOKIE_SECURE=1
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
