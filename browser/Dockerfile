FROM node:24-trixie-slim

# Debian's chromium reads enterprise policy from /etc/chromium/policies/managed/
# and external extension JSON from /usr/share/chromium/extensions/. Each test
# scenario writes its own install method there, so make both writable by the
# test user (test container only - never do this on a real machine).
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium xvfb xauth fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /etc/chromium/policies/managed /usr/share/chromium/extensions \
 && chown node:node /etc/chromium/policies/managed /usr/share/chromium/extensions

ENV CHROME_BIN=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tests ./tests
RUN mkdir -p artifacts && chown node:node artifacts

USER node
# Scenarios share one update server, so run test files one at a time.
# TESTS selects files (default: all). HEADLESS=0 runs headed Chromium under Xvfb.
CMD ["sh", "-c", "run='node --test --test-concurrency=1 --test-reporter=spec'; files=\"${TESTS:-tests/**/*.test.mjs}\"; if [ \"$HEADLESS\" = 0 ]; then exec xvfb-run -a $run \"$files\"; else exec $run \"$files\"; fi"]
