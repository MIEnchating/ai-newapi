import { chromium } from 'playwright-core';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const baseUrl = 'http://localhost:3000';
const views = ['overview', 'channels', 'rates', 'credentials', 'alerts'];

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true
});

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ensureLoggedIn(page);
await page.goto(baseUrl, { waitUntil: 'networkidle' });

const results = [];

for (const view of views) {
  await page.click(`.ant-menu-item[data-menu-id*="${view}"]`).catch(async () => {
    await page.locator('.ant-menu-item').filter({ hasText: viewLabel(view) }).click();
  });
  await page.waitForTimeout(300);
  const metrics = await page.evaluate(() => {
    const header = document.querySelector('.app-header')?.getBoundingClientRect();
    const content = document.querySelector('.app-content')?.getBoundingClientRect();
    const bodyOverflow = document.documentElement.scrollHeight > document.documentElement.clientHeight;
    const cards = [...document.querySelectorAll('.ant-card')].map((card) => {
      const rect = card.getBoundingClientRect();
      const table = card.querySelector('.ant-table-wrapper')?.getBoundingClientRect();
      return {
        title: card.querySelector('.ant-card-head-title')?.textContent?.trim() ?? '',
        cardRight: rect.right,
        tableRight: table?.right ?? null,
        overflows: table ? table.right - rect.right > 2 : false
      };
    });

    return {
      headerBottom: header?.bottom,
      contentTop: content?.top,
      headerOverlapsContent: header && content ? header.bottom > content.top : false,
      bodyOverflow,
      cards
    };
  });

  results.push({ view, ...metrics });
}

console.log(JSON.stringify(results, null, 2));
await browser.close();

function viewLabel(view) {
  return {
    overview: '总览',
    channels: '渠道管理',
    rates: '倍率快照',
    credentials: '渠道凭证',
    alerts: '告警'
  }[view];
}

async function ensureLoggedIn(page) {
  const username = process.env.E2E_LOGIN_USER ?? 'admin';
  const password = process.env.E2E_LOGIN_PASSWORD;
  if (!password) {
    throw new Error('E2E_LOGIN_PASSWORD is required for authenticated checks');
  }
  const statusResponse = await page.request.get(`${baseUrl}/api/auth/status`);
  const status = await statusResponse.json();
  const endpoint = status.setupRequired ? 'setup' : 'login';
  const response = await page.request.post(`${baseUrl}/api/auth/${endpoint}`, {
    data: { username, password }
  });

  if (!response.ok()) {
    throw new Error(`login failed: ${response.status()} ${await response.text()}`);
  }
}
