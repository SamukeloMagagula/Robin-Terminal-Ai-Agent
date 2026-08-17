# Robin in a container.
#
#   docker build -t robin .
#   docker run -it --rm -v robin-data:/home/robin/.robin robin doctor
#
# The volume matters: ~/.robin holds credentials, memory, skills and
# conversations. Without it every run starts logged out and forgetful.
#
# Worth knowing before you reach for this. Robin runs shell commands the model
# asks for, and a container is the one place that is genuinely contained —
# which is the argument for it. But it also means the model can only see files
# you mounted, and `robin serve` still reaches out to Telegram, Discord or
# Slack, so a container is isolation, not disconnection.

FROM node:22-alpine AS build
WORKDIR /app

# The lockfile alone first, so dependencies are cached until they change.
COPY package.json package-lock.json ./
# ci, not install: exact-pinned dependencies are the point of the lockfile.
# --ignore-scripts skips the prepare hook, which builds before src exists.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# better-sqlite3 is a native addon compiled against this image's Node ABI, so
# the runtime stage must be the same base — a different one loads a binary
# built for a runtime that is not there.
FROM node:22-alpine
WORKDIR /app

RUN addgroup -S robin && adduser -S robin -G robin

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist

# Robin writes to ~/.robin, so it needs a home it owns. Running as root would
# also mean every command the model runs is a root command.
RUN mkdir -p /home/robin/.robin && chown -R robin:robin /home/robin /app
USER robin
ENV HOME=/home/robin

# The gateway's port, for `robin ui` and the OpenAI-compatible API. Loopback
# inside the container, so publishing it is a deliberate act.
EXPOSE 18790

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["doctor"]
