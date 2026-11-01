import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const base = process.env.JOT_TEST_URL || 'http://127.0.0.1:3129';
async function enterWrite(page) {
  const input = page.getByLabel('Note body in Markdown');
  if (!await input.isVisible()) await page.getByRole('button', { name: 'Write', exact: true }).click();
  await input.waitFor({ state: 'visible' });
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByLabel('Note title').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return !!registration?.active && !!navigator.serviceWorker.controller;
  }, null, { timeout: 30000 });
  const cacheState = await page.evaluate(async () => {
    const manifest = await (await fetch('/offline-assets.json')).json();
    const cache = await caches.open('jot-offline-shell-v1');
    const missing = [];
    for (const asset of manifest.assets) if (!await cache.match(asset)) missing.push(asset);
    return { shell: !!await cache.match('/'), missing, keys: (await cache.keys()).map(request => new URL(request.url).pathname) };
  });
  assert.equal(cacheState.shell, true);
  assert.deepEqual(cacheState.missing, []);
  assert.equal(cacheState.keys.some(path => path.startsWith('/api/')), false);
  await page.getByRole('button', { name: 'New note', exact: true }).first().click();
  await page.getByLabel('Note title').fill('Offline proof');
  await enterWrite(page);
  await page.getByLabel('Note body in Markdown').fill('Created before going offline.');
  await page.locator('.save-indicator').getByText('Saved locally').waitFor({ timeout: 10000 });
  await context.setOffline(true);
  await page.close();
  const offlinePage = await context.newPage();
  offlinePage.on('pageerror', error => failures.push(error.message));
  await offlinePage.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await offlinePage.getByRole('button', { name: /Offline proof/ }).waitFor({ state: 'visible', timeout: 15000 });
  await offlinePage.getByRole('button', { name: /Offline proof/ }).click();
  await enterWrite(offlinePage);
  assert.equal(await offlinePage.getByLabel('Note body in Markdown').inputValue(), 'Created before going offline.');
  await offlinePage.getByLabel('Note body in Markdown').fill('Edited and saved completely offline.');
  await offlinePage.locator('.save-indicator').getByText('Saved locally').waitFor({ timeout: 10000 });
  await offlinePage.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
  await offlinePage.getByRole('button', { name: /Offline proof/ }).click();
  await enterWrite(offlinePage);
  assert.equal(await offlinePage.getByLabel('Note body in Markdown').inputValue(), 'Edited and saved completely offline.');
  assert.deepEqual(failures, []);
  console.log(`PASS: ${cacheState.keys.length} shell assets cached; offline reopen, edit, save and second reload succeeded; no API responses cached.`);
  await context.close();
} finally { await browser.close(); }
