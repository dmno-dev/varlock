// Self-contained test: starts an HTTP server, makes requests, reports results
// auto-load patches ServerResponse to detect leaked sensitive values
import 'varlock/auto-load';
import http, { createServer } from 'node:http';
import { ENV } from 'varlock/env';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', (err) => reject(err));
  });
}

const server = createServer((req, res) => {
  if (req.url === '/safe') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`public::${ENV.PUBLIC_VAR}`);
  } else if (req.url === '/leak') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    // This should trigger leak detection
    res.end(`secret::${ENV.SECRET_TOKEN}`);
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(0, async () => {
  const port = server.address().port;
  try {
    // Safe endpoint should work
    const safeResp = await httpGet(`http://localhost:${port}/safe`);
    console.log(`safe-status::${safeResp.status}`);
    console.log(`safe-body::${safeResp.body}`);

    // Leaky endpoint should trigger leak detection
    try {
      await httpGet(`http://localhost:${port}/leak`);
      console.log('leak-not-detected');
    } catch (err) {
      console.log('leak-request-error');
    }
  } finally {
    server.close();
  }
});
