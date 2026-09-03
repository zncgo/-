FROM node:24-alpine

WORKDIR /app
COPY core.mjs cookie-pool.mjs server.mjs index.html workbook.mjs workbook-runner.mjs workbook-ui.mjs ./
COPY vendor ./vendor

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.mjs"]
