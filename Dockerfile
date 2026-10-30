FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# The bridge only uses Node's standard library; there are no packages to install.
COPY package.json ./
COPY src/ ./src/
RUN mkdir /app/.local && chown node:node /app/.local

USER node
EXPOSE 8787 1455
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:8787/health', {signal: AbortSignal.timeout(3000)}); if (!r.ok || (await r.json()).status !== 'ok') process.exit(1);"]

ENTRYPOINT ["node", "src/cli.mjs"]
CMD ["serve", "--host", "0.0.0.0"]
