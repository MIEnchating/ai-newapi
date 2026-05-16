import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true
});

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

await cleanupTestChannels();
await cleanupTestEvents();
await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

await page.getByRole('button', { name: '同步渠道' }).click();
await page.waitForTimeout(900);
const synced = await page.getByText('刚刚').first().isVisible();

const sub2Created = await createChannel({
  name: 'Sub2API 自动检查',
  typeTitle: 'Sub2API 上游',
  upstreamName: 'Sub2API 自动检查池',
  baseUrl: 'https://sub2api-check.example.com',
  credential: 'sub2api-test-key'
});

const cliCreated = await createChannel({
  name: 'CLI Proxy 自动检查',
  typeTitle: 'CLI Proxy API',
  upstreamName: 'CLI Proxy 自动检查上游',
  baseUrl: 'https://cli-proxy-check.example.com'
});

const ratioCreated = await createChannel({
  name: '充值比例自动检查',
  typeTitle: 'NewAPI 上游',
  upstreamName: '充值比例自动检查上游',
  baseUrl: 'https://ratio-check.example.com',
  userId: '1',
  rechargeRatio: '10',
  credential: 'newapi-test-key'
});

await page.getByPlaceholder('搜索渠道、上游、模型').fill('充值比例自动检查');
await page.waitForTimeout(300);
const ratioRow = page.locator('.ant-table-row').filter({ hasText: '充值比例自动检查' }).first();
const ratioVisible = await ratioRow.isVisible();
const ratioShown = await ratioRow.getByText('1:10').isVisible();
await ratioRow.getByRole('button', { name: '配置' }).click();
await page.waitForTimeout(300);
const ratioInputValue = await page.locator('.ant-modal .ratio-input input').inputValue();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

await page.getByPlaceholder('搜索渠道、上游、模型').fill('CLI Proxy 自动检查');
await page.waitForTimeout(300);
const cliRow = page.locator('.ant-table-row').filter({ hasText: 'CLI Proxy 自动检查' }).first();
const cliVisible = await cliRow.isVisible();
const cliIgnoredCells = await cliRow.getByText('忽略').count();
const detailButtons = await page.getByText('查看详情').count();

await cliRow.getByRole('button', { name: '配置' }).click();
await page.waitForTimeout(300);
const editModalTitle = await page.locator('.ant-modal-title').textContent();
const editModalText = await page.locator('.ant-modal').textContent();

const hitNetwork =
  apiCalls.some((call) => call.url.includes('/api/channels/sync')) &&
  apiCalls.some((call) => call.method === 'POST' && call.url.endsWith('/api/channels'));

await cleanupTestChannels();
await cleanupTestEvents();
await browser.close();

console.log(
  JSON.stringify(
    {
      synced,
      sub2Created,
      cliCreated,
      ratioCreated,
      cliVisible,
      cliIgnoredCells,
      ratioVisible,
      ratioShown,
      ratioInputValue,
      ratioInputIsInteger: ratioInputValue === '10',
      detailButtons,
      editModalTitle,
      editModalHasCliNote: editModalText.includes('CLI Proxy API 不读取余额和倍率'),
      hitNetwork,
      consoleMessages,
      apiCalls
    },
    null,
    2
  )
);

async function createChannel({ name, typeTitle, upstreamName, baseUrl, userId, rechargeRatio, credential }) {
  await page.getByPlaceholder('搜索渠道、上游、模型').fill('');
  await page.getByRole('button', { name: /新增渠道/ }).click();
  await page.getByLabel('渠道名称').fill(name);
  await page.getByLabel('Key 所属分组').fill('default');
  await page.getByLabel('渠道上游类型').click();
  await page.getByTitle(typeTitle).locator('div').click();
  await page.getByLabel('上游名称').fill(upstreamName);
  await page.getByLabel('上游 Base URL').fill(baseUrl);
  const userIdField = page.getByLabel('上游用户 ID');
  if (await userIdField.isVisible().catch(() => false)) {
    await userIdField.fill(userId ?? '1');
  }
  if (credential) {
    await page.getByLabel('上游 Key / Token').fill(credential);
  }
  if (rechargeRatio) {
    await page.locator('#rechargeRatio').fill(rechargeRatio);
  }
  await page.locator('.ant-modal-footer .ant-btn-primary').click();
  await page.locator('.ant-modal').waitFor({ state: 'hidden', timeout: 5000 });
  await page.getByRole('menuitem', { name: /渠道管理/ }).click();
  await page.getByPlaceholder('搜索渠道、上游、模型').fill(name);
  const row = page.locator('.ant-table-row').filter({ hasText: name }).first();
  await row.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);

  return row.isVisible();
}

async function cleanupTestChannels() {
  const response = await fetch('http://localhost:3000/api/channels');
  const payload = await response.json();
  const targets = payload.channels.filter((channel) => /自动检查|测试渠道/.test(channel.name));

  await Promise.all(
    targets.map((channel) =>
      fetch(`http://localhost:3000/api/channels?id=${encodeURIComponent(channel.id)}`, {
        method: 'DELETE'
      })
    )
  );
}

async function cleanupTestEvents() {
  await fetch('http://localhost:3000/api/events?testOnly=1', {
    method: 'DELETE'
  });
}
