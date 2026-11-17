'use strict';
const {chromium} = require('playwright');

// Real wall-clock polling: virtual-time-budget can expire the application's
// Fog readiness timer before asynchronous network data has arrived.
async function main() {
  const base = process.env.PAGE_URL;
  if (!base) throw new Error('PAGE_URL is required');
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const url = new URL('taf.html', base.replace(/\/?$/, '/'));
    url.searchParams.set('v', process.env.GITHUB_SHA || 'smoke');
    await page.goto(url.href, {waitUntil: 'domcontentloaded', timeout: 60000});
    await page.waitForFunction(() =>
      document.documentElement.dataset.tafStartup === 'app-ready' &&
      document.querySelector('#cycle option[value="0"]'), null, {timeout: 30000});
    if (!(await page.locator('body').innerText()).includes('AKTYWNY: LEGACY')) {
      throw new Error('Fresh TAF session does not default to LEGACY');
    }
    // Wait for the selected model and Fog data before exercising generation.
    await page.waitForFunction(() => {
      const w = document.getElementById('engine')?.contentWindow;
      try {
        return w && w.eval('typeof consensus!=="undefined"?consensus.length:0') > 10 &&
          window.PrognozaEPIRTAFFogPolicy?.seriesForTaf(w)?.length > 10;
      } catch (_) { return false; }
    }, null, {timeout: 120000});
    await page.locator('#gen').click();
    await page.waitForFunction(() => document.querySelectorAll('#hours tr').length >= 8,
      null, {timeout: 90000});
    console.log('TAF browser smoke: UTC cycles, LEGACY and hourly rows OK');
  } catch (error) {
    console.error('TAF browser smoke failed:', error.message);
    console.error(await page.evaluate(() => Object.fromEntries(
      ['st', 'taf', 'badge'].map(id => [id, document.getElementById(id)?.textContent]))).catch(() => ({})));
    console.error('Page errors:', errors);
    throw error;
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
