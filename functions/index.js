const { onRequest } = require('firebase-functions/v2/https');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors({ origin: true }));

app.use(async (req, res) => {
  const targetUrl = req.query.url;
  const filename = req.query.filename;
  if (!targetUrl) return res.status(400).send('Missing url parameter');
  
  try {
    const fetchRes = await fetch(targetUrl);
    if (!fetchRes.ok) {
      return res.status(fetchRes.status).send('Upstream Error: ' + fetchRes.statusText);
    }
    
    res.set('Content-Type', 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=3600');
    
    if (filename) {
      res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    }
    
    fetchRes.body.pipe(res);
  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).send('Internal Server Error: ' + err.message);
  }
});

// Explicitly set invoker to 'public' to ensure Cloud Run allows unauthenticated access
exports.proxyGlb = onRequest({ invoker: 'public', memory: '256MiB', maxInstances: 10 }, app);
