import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true
});
const baseUrl = 'http://localhost:3000';
const testName = `CPA 自动检查-${Date.now()}`;

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const consoleMessages = [];
const apiCalls = [];

page.on('console', (message) => {
  if (message.type() === 'warning' || message.type() === 'error') {
    consoleMessages.push(`${message.type()}: ${message.text()}`);
  }
});
page.on('request', (request) => {
  const url = request.url();
  if (url.includes('/api/')) {
    apiCalls.push({ method: request.method(), url });
  }
});

await ensureLoggedIn();
await cleanupTestChannels();
await cleanupTestEvents();
await page.goto(baseUrl, { waitUntil: 'networkidle' });

await page.getByRole('button', { name: /新增渠道/ }).click();
await page.getByLabel('平台分组（列表分组）').fill(testName);
await page.getByLabel('上游 Base URL').fill('https://cpa-check.example.com');
await selectChannelType('CPA（号池模式）');

const modal = page.locator('.ant-modal').filter({ hasText: '新增渠道' }).last();
const cpaNoteVisible = await modal.getByText('CPA 是号池模式', { exact: false }).isVisible();
const keyNameVisibleForCpa = await modal.getByLabel('Key 名称').isVisible().catch(() => false);
const rateGroupVisibleForCpa = await modal.getByLabel('上游分组（倍率分组）').isVisible().catch(() => false);

await page.locator('.ant-modal-footer .ant-btn-primary').click();
await page.locator('.ant-modal').waitFor({ state: 'hidden', timeout: 30000 });

await page.getByPlaceholder('搜索渠道、上游、分组').fill(testName);
const row = page.locator('.ant-table-row').filter({ hasText: testName }).first();
await row.waitFor({ state: 'visible', timeout: 5000 });
const cpaCreated = await row.isVisible();
const cpaProviderShown = await row.getByText('CPA', { exact: false }).isVisible();

await row.getByRole('button', { name: '配置' }).click();
await page.locator('.ant-modal').filter({ hasText: '配置渠道' }).waitFor({ state: 'visible', timeout: 5000 });
const editTypeText = await page.locator('.ant-modal').textContent();
const cpaStillSelectedOnEdit = editTypeText.includes('CPA（号池模式）') || editTypeText.includes('CPA 是号池模式');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

await cleanupTestChannels();
await cleanupTestEvents();
await browser.close();

console.log(
  JSON.stringify(
    {
      cpaNoteVisible,
      keyNameHiddenForCpa: !keyNameVisibleForCpa,
      rateGroupHiddenForCpa: !rateGroupVisibleForCpa,
      cpaCreated,
      cpaProviderShown,
      cpaStillSelectedOnEdit,
      hitNetwork: apiCalls.some((call) => call.method === 'POST' && call.url.endsWith('/api/channels')),
      consoleMessages,
      apiCalls
    },
    null,
    2
  )
);

async function selectChannelType(label) {
  await page.getByLabel('渠道上游类型').click();
  const dropdown = page.locator('.ant-select-dropdown:visible').last();
  await dropdown.locator('.ant-select-item-option').filter({ hasText: label }).click();
}

async function cleanupTestChannels() {
  const response = await page.request.get(`${baseUrl}/api/channels`);
  if (!response.ok()) {
    return;
  }

  const payload = await response.json();
  const targets = (payload.channels ?? []).filter((channel) => /自动检查|测试渠道/.test(channel.name));

  await Promise.all(
    targets.map((channel) =>
      page.request.delete(`${baseUrl}/api/channels?id=${encodeURIComponent(channel.id)}`)
    )
  );
}

async function cleanupTestEvents() {
  await page.request.delete(`${baseUrl}/api/events?testOnly=1`);
}

async function ensureLoggedIn() {
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
