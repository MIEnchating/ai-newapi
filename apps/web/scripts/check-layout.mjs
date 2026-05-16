import { chromium } from 'playwright-core';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const views = ['overview', 'relays', 'channels', 'rates', 'credentials', 'alerts'];

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true
});

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

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
    relays: '中转站',
    channels: '渠道管理',
    rates: '倍率快照',
    credentials: '凭据',
    alerts: '告警'
  }[view];
}
