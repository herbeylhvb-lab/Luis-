const express = require('express');
const router = express.Router();
const googleTrends = require('google-trends-api');

// Retry wrapper for Google Trends API (they rate-limit cloud IPs aggressively)
async function withRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1))); // backoff
    }
  }
}

// Interest over time for a keyword
router.get('/trends/interest', async (req, res) => {
  try {
    const { keyword, geo, time } = req.query;
    if (!keyword) return res.status(400).json({ error: 'keyword required' });

    const options = {
      keyword,
      startTime: new Date(Date.now() - (parseInt(time) || 90) * 24 * 60 * 60 * 1000),
      geo: geo || 'US-TX',
      granularTimeResolution: false
    };

    const results = await withRetry(() => googleTrends.interestOverTime(options));
    const parsed = JSON.parse(results);
    const timeline = (parsed.default?.timelineData || []).map(t => ({
      date: t.formattedAxisTime || t.formattedTime,
      value: t.value?.[0] || 0,
      formattedValue: t.formattedValue?.[0] || '0'
    }));

    res.json({ keyword, geo: options.geo, timeline });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to fetch trends' });
  }
});

// Compare multiple keywords
router.get('/trends/compare', async (req, res) => {
  try {
    const { keywords, geo, time } = req.query;
    if (!keywords) return res.status(400).json({ error: 'keywords required (comma-separated)' });

    const keywordList = keywords.split(',').map(k => k.trim()).filter(Boolean).slice(0, 5);
    const options = {
      keyword: keywordList,
      startTime: new Date(Date.now() - (parseInt(time) || 90) * 24 * 60 * 60 * 1000),
      geo: geo || 'US-TX',
      granularTimeResolution: false
    };

    const results = await withRetry(() => googleTrends.interestOverTime(options));
    const parsed = JSON.parse(results);
    const timeline = (parsed.default?.timelineData || []).map(t => {
      const point = { date: t.formattedAxisTime || t.formattedTime };
      keywordList.forEach((kw, i) => {
        point[kw] = t.value?.[i] || 0;
      });
      return point;
    });

    res.json({ keywords: keywordList, geo: options.geo, timeline });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to fetch trends' });
  }
});

// Interest by region (city/DMA breakdown)
router.get('/trends/regions', async (req, res) => {
  try {
    const { keyword, geo, resolution } = req.query;
    if (!keyword) return res.status(400).json({ error: 'keyword required' });

    const options = {
      keyword,
      startTime: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      geo: geo || 'US-TX',
      resolution: resolution || 'CITY'
    };

    const results = await withRetry(() => googleTrends.interestByRegion(options));
    const parsed = JSON.parse(results);
    const regions = (parsed.default?.geoMapData || []).map(r => ({
      name: r.geoName,
      code: r.geoCode,
      value: r.value?.[0] || 0
    })).sort((a, b) => b.value - a.value);

    res.json({ keyword, geo: options.geo, resolution: options.resolution, regions });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to fetch regional trends' });
  }
});

// Related queries (what people also search)
router.get('/trends/related', async (req, res) => {
  try {
    const { keyword, geo } = req.query;
    if (!keyword) return res.status(400).json({ error: 'keyword required' });

    const options = {
      keyword,
      startTime: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      geo: geo || 'US-TX'
    };

    const results = await withRetry(() => googleTrends.relatedQueries(options));
    const parsed = JSON.parse(results);
    const data = parsed.default?.rankedList || [];

    const top = (data[0]?.rankedKeyword || []).map(r => ({
      query: r.query,
      value: r.value
    }));
    const rising = (data[1]?.rankedKeyword || []).map(r => ({
      query: r.query,
      value: r.formattedValue || r.value
    }));

    res.json({ keyword, top, rising });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to fetch related queries' });
  }
});

// Campaign-relevant fallback topics (shown when Google blocks cloud-server IPs).
// Ordered by regional relevance for Brownsville / Cameron County / TX politics.
const FALLBACK_TOPICS = [
  'early voting 2026', 'cameron county election', 'port of brownsville',
  'texas primary 2026', 'spacex brownsville', 'immigration border',
  'property taxes texas', 'jobs brownsville', 'water district',
  'us congress tx-34', 'texas voter registration', 'mail in ballot texas',
  'hidalgo county election', 'beto orourke', 'greg abbott',
  'navigation district', 'port commissioner', 'school board texas',
  'minimum wage texas', 'border security'
];
function fallbackStories() {
  return FALLBACK_TOPICS.slice(0, 20).map((q, i) => ({
    title: q, entityNames: [], traffic: String(100 - i * 4), articles: []
  }));
}
function fallbackSearches() {
  return FALLBACK_TOPICS.slice(0, 20).map((q, i) => ({
    title: q, traffic: String(100 - i * 4), articles: [], relatedQueries: []
  }));
}

// Simple in-memory cache to avoid hammering Google (15 min TTL)
const _trendsCache = { realtime: {}, daily: {} };
const CACHE_TTL = 15 * 60 * 1000;
function getCached(bucket, key) {
  const hit = bucket[key];
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
  return null;
}
function setCached(bucket, key, data) { bucket[key] = { at: Date.now(), data }; }

// "Trending now" — derived from relatedQueries (rising) of a seed keyword.
// Falls back to curated campaign topics if Google blocks the cloud IP.
router.get('/trends/realtime', async (req, res) => {
  const seed = req.query.seed || 'election 2026';
  const geo = req.query.geo || 'US';
  const cacheKey = seed + '|' + geo;
  const cached = getCached(_trendsCache.realtime, cacheKey);
  if (cached) return res.json(cached);

  try {
    const results = await withRetry(() => googleTrends.relatedQueries({
      keyword: seed,
      startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      geo
    }));
    const parsed = JSON.parse(results);
    const rising = parsed.default?.rankedList?.[1]?.rankedKeyword || [];
    if (rising.length === 0) throw new Error('no rising queries returned');
    const stories = rising.slice(0, 20).map(r => ({
      title: r.query, entityNames: [],
      traffic: r.formattedValue || String(r.value || ''), articles: []
    }));
    const payload = { stories, seed, source: 'related_rising' };
    setCached(_trendsCache.realtime, cacheKey, payload);
    res.json(payload);
  } catch (e) {
    console.warn('[trends/realtime] Google blocked — using fallback:', e.message);
    res.json({ stories: fallbackStories(), seed, source: 'fallback_curated', warning: 'Google Trends rate-limited this server — showing curated campaign topics.' });
  }
});

// "Daily trending" — uses relatedQueries (top) with fallback to curated topics.
router.get('/trends/daily', async (req, res) => {
  const seed = req.query.seed || 'election 2026';
  const geo = req.query.geo || 'US';
  const cacheKey = seed + '|' + geo;
  const cached = getCached(_trendsCache.daily, cacheKey);
  if (cached) return res.json(cached);

  try {
    const results = await withRetry(() => googleTrends.relatedQueries({
      keyword: seed,
      startTime: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      geo
    }));
    const parsed = JSON.parse(results);
    const top = parsed.default?.rankedList?.[0]?.rankedKeyword || [];
    if (top.length === 0) throw new Error('no top queries returned');
    const searches = top.slice(0, 25).map(r => ({
      title: r.query,
      traffic: r.formattedValue || String(r.value || ''),
      articles: [], relatedQueries: []
    }));
    const payload = { searches, seed, source: 'related_top' };
    setCached(_trendsCache.daily, cacheKey, payload);
    res.json(payload);
  } catch (e) {
    console.warn('[trends/daily] Google blocked — using fallback:', e.message);
    res.json({ searches: fallbackSearches(), seed, source: 'fallback_curated', warning: 'Google Trends rate-limited this server — showing curated campaign topics.' });
  }
});

module.exports = router;
