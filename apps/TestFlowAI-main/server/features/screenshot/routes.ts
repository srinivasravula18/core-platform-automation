import type { Express } from 'express';

export function registerScreenshotRoutes(app: Express) {
  app.get('/api/screenshot', (req, res) => {
    const targetUrlRaw = req.query.url as string;
    if (!targetUrlRaw) {
      return res.status(400).send('Missing url query parameter');
    }

    if (targetUrlRaw.startsWith('/evidence/')) {
      return res.redirect(targetUrlRaw);
    }

    let targetUrl = targetUrlRaw;
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = `https://${targetUrl}`;
    }

    try {
      const screenshotServiceUrl = `https://image.thum.io/get/width/1280/crop/800/maxAge/12/${targetUrl}`;
      res.redirect(screenshotServiceUrl);
    } catch (error) {
      console.error('Screenshot redirection error:', error);
      res.status(500).send('Screenshot capture failed');
    }
  });
}
