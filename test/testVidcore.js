/* global document */
const { chromium } = require('playwright-core');
const fs = require('fs');

const candidates = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
];
const executable = candidates.find(file => fs.existsSync(file));

(async () => {
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('request', req => {
    const u = req.url();
    if (!u.includes('google') && !u.includes('umami') && !u.includes('.png') && !u.includes('.jpg') && !u.includes('.woff') && !u.includes('.css')) {
      console.log('REQ:', req.method(), u);
    }
  });
  console.log('goto...');
  await page.goto('https://vidcore.io/movie/550', { waitUntil: 'networkidle', timeout: 30000 });
  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => b.innerText || b.className));
  console.log('Buttons:', buttons);
  await browser.close();
})().catch(console.error);
