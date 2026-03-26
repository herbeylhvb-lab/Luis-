const express = require('express');
const router = express.Router();
const googleTrends = require('google-trends-api');

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

    const results = await googleTrends.interestOverTime(options);
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

    const results = await googleTrends.interestOverTime(options);
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

    const results = await googleTrends.interestByRegion(options);
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

    const results = await googleTrends.relatedQueries(options);
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

// Real-time trending searches
router.get('/trends/realtime', async (req, res) => {
  try {
    const { geo } = req.query;
    const results = await googleTrends.realTimeTrends({
      geo: geo || 'US',
      category: 'all'
    });
    const parsed = JSON.parse(results);
    const stories = (parsed.storySummaries?.trendingStories || []).slice(0, 20).map(s => ({
      title: s.title,
      entityNames: s.entityNames || [],
      articles: (s.articles || []).slice(0, 3).map(a => ({
        title: a.articleTitle,
        url: a.url,
        source: a.source,
        time: a.time
      }))
    }));

    res.json({ stories });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to fetch realtime trends' });
  }
});

// Daily trending searches
router.get('/trends/daily', async (req, res) => {
  try {
    const { geo } = req.query;
    const results = await googleTrends.dailyTrends({
      trendDate: new Date(),
      geo: geo || 'US'
    });
    const parsed = JSON.parse(results);
    const days = parsed.default?.trendingSearchesDays || [];
    const searches = [];
    days.forEach(day => {
      (day.trendingSearches || []).forEach(s => {
        searches.push({
          title: s.title?.query || '',
          traffic: s.formattedTraffic || '',
          articles: (s.articles || []).slice(0, 2).map(a => ({
            title: a.title,
            url: a.url,
            source: a.source
          })),
          relatedQueries: (s.relatedQueries || []).map(r => r.query).slice(0, 5)
        });
      });
    });

    res.json({ searches: searches.slice(0, 25) });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to fetch daily trends' });
  }
});

module.exports = router;
