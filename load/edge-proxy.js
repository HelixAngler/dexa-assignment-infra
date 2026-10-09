'use strict';
// Local HTTP forwarder: listens on 127.0.0.1:18080 and relays to the edge on
// 127.0.0.1:8080 through a bounded keep-alive pool. Thousands of client
// connections collapse onto UPSTREAM_MAX sockets, so the host-to-VM port
// multiplexer only ever sees a small, fixed number of channels.
const http = require('http');
const { setInterval } = require('timers');

const LISTEN_PORT = Number(process.env.PROXY_LISTEN || 18080);
const TARGET_PORT = Number(process.env.PROXY_TARGET || 8080);
const UPSTREAM_MAX = Number(process.env.PROXY_MAX_SOCKETS || 150);

const upstream = new http.Agent({
  keepAlive: true,
  maxSockets: UPSTREAM_MAX,
  maxFreeSockets: UPSTREAM_MAX,
  keepAliveMsecs: 15000,
});

let forwarded = 0;
let failed = 0;
const started = Date.now();

const server = http.createServer((req, res) => {
  const headers = Object.assign({}, req.headers);
  delete headers.connection;
  delete headers['keep-alive'];
  headers.host = `127.0.0.1:${TARGET_PORT}`;

  const proxied = http.request(
    {
      host: '127.0.0.1',
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers,
      agent: upstream,
    },
    (upstreamRes) => {
      forwarded += 1;
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  proxied.setTimeout(35000, () => proxied.destroy(new Error('upstream timeout')));
  proxied.on('error', (err) => {
    failed += 1;
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end(`proxy error: ${err.message}`);
  });
  req.pipe(proxied);
});

server.requestTimeout = 45000;
server.headersTimeout = 20000;
server.keepAliveTimeout = 65000;
server.maxHeadersCount = 200;

server.on('clientError', (_err, socket) => {
  socket.destroy();
});

setInterval(() => {
  const secs = Math.round((Date.now() - started) / 1000);
  const pool = Object.keys(upstream.sockets).length;
  console.log(`t=${secs}s forwarded=${forwarded} failed=${failed} upstream_sockets=${pool} free=${Object.keys(upstream.freeSockets).length}`);
}, 15000).unref();

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`proxy listening on 127.0.0.1:${LISTEN_PORT} -> 127.0.0.1:${TARGET_PORT} (max ${UPSTREAM_MAX} sockets)`);
});
