# Optional prebuilt sandbox image for test execution (SANDBOX_IMAGE).
# The default node:22-alpine works without this; build this only to preinstall toolchains.
FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
USER node
WORKDIR /work
