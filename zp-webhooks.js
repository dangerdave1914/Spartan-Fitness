// zp-webhooks.js — Zen Planner webhook logger (capture first, parse later)
// Logs every delivery raw so we can see Zen Planner's real payload and how it
// sends the account ID / shared secret, then write the real handler against that.
const express = require('express');
const router = express.Router();

const FEEDS = ['people', 'class-sessions', 'attendance'];
const recent = []; // last 50 deliveries, in memory — resets on redeploy

// Raw body parser so nothing gets dropped, whatever content type they send.
router.post('/webhooks/zp/:feed', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const { feed } = req.params;
  if (!FEEDS.includes(feed)) return res.sendStatus(404);

  const entry = {
    at: new Date().toISOString(),
    feed,
    headers: req.headers,
    query: req.query,
    body: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '',
  };

  console.log('[zp-webhook]', JSON.stringify(entry)); // shows in DO Runtime Logs
  recent.unshift(entry);
  if (recent.length > 50) recent.pop();

  res.sendStatus(200); // answer fast so Zen Planner doesn't retry or disable the hook
});

// View captures from your phone: /webhooks/zp/recent?key=YOUR_ZP_VIEW_KEY
router.get('/webhooks/zp/recent', (req, res) => {
  const key = process.env.ZP_VIEW_KEY;
  if (!key || req.query.key !== key) return res.sendStatus(403);
  res.json(recent);
});

module.exports = router;
