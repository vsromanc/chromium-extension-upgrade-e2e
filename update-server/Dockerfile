FROM node:24-trixie-slim
WORKDIR /srv
COPY server.mjs .
USER node
EXPOSE 8080
HEALTHCHECK --interval=2s --timeout=2s --retries=15 \
  CMD node -e "fetch('http://localhost:8080/_admin/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
