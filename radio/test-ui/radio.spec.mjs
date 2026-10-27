import { test, expect } from '@playwright/test';

// All fixtures below are invented. No real music, Drive folder, token or Discord login.
const origin = 'http://127.0.0.1:8080';
let errors, externalRequests;
test.beforeEach(async ({ page }) => {
  errors = []; externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
});
test.afterEach(() => {
  expect(errors, 'No uncaught browser JavaScript errors').toEqual([]);
  expect(externalRequests, 'Browser must never request external resources').toEqual([]);
});
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function screenshot(page, info, label) {
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath(`${label}-${info.project.name}.png`), fullPage: true, animations: 'disabled' });
}

test('real app: unconfigured guidance and responsive layout', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#connection')).toContainText('Configuration requise');
  await expect(page.locator('#notice')).toBeVisible();
  await expect(page.locator('#notice')).toContainText('Home Assistant');
  await expect(page.locator('#toggle')).toBeDisabled();
  await expect(page.locator('#volume')).toBeDisabled();
  await expect(page.locator('#add-source')).toBeEnabled();
  await expect(page.locator('#sources-list')).toContainText('Ajoutez une première source');
  await screenshot(page, info, 'nonconnected-real-app');
});

test('real app: invalid and private sources are refused without import', async ({ page }) => {
  const posts = [];
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('#add-source')).toBeEnabled();
  await page.locator('#source-url').fill('not-a-url');
  await page.locator('#add-source').click();
  expect(await page.locator('#source-url').evaluate(input => input.validity.typeMismatch)).toBe(true);
  expect(posts).toHaveLength(0);
  await page.locator('#source-url').fill('http://localhost/test.mp3');
  await page.locator('#add-source').click();
  await expect(page.locator('#toast')).toHaveText('Utilisez un lien HTTPS valide.');
  expect(posts).toHaveLength(0);
  for (const url of ['https://localhost/test.mp3', 'https://127.0.0.1/test.mp3']) {
    await page.locator('#source-url').fill(url);
    const response = page.waitForResponse(response => response.url() === `${origin}/api/sources` && response.request().method() === 'POST');
    await page.locator('#add-source').click();
    expect((await response).status()).toBe(400);
    await expect(page.locator('#toast')).toContainText('Use a public HTTPS');
    await expect(page.locator('#add-source')).toBeEnabled();
  }
  // These literal private hosts are rejected synchronously, before any importer/DNS call.
  const state = await (await page.request.get('/api/status')).json();
  expect(state.sources).toEqual([]);
});

async function mockLibrary(page) {
  const writes = [];
  let polls = 0;
  const state = {
    configured: true, csrfToken: 'synthetic-ui-only-not-a-credential',
    connection: { state: 'disconnected', channel: null },
    playback: { state: 'stopped', title: null, elapsed: 0, duration: null, volume: 0.6 },
    sources: [{ id: 'synthetic-source', type: 'direct', name: 'Source fictive — test UI', url: 'https://example.invalid/demo.mp3', state: 'ready', count: 2 }],
    tracks: [{ id: 'demo-a', title: 'Piste fictive Alpha' }, { id: 'demo-b', title: 'Piste fictive Beta' }],
  };
  // Intercepts every API request: this fixture cannot import media or contact Discord.
  await page.route('**/api/**', async route => {
    const request = route.request();
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/status') {
      polls++;
      return route.fulfill({ json: state });
    }
    writes.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() });
    return route.fulfill({ json: { ok: true } });
  });
  return { writes, state, polls: () => polls };
}

test('mock-only library: search, source controls, modal cancellation', async ({ page }, info) => {
  const mock = await mockLibrary(page);
  await page.goto('/');
  await expect(page.locator('#connection')).toContainText('Discord déconnecté');
  await expect(page.locator('#source-count')).toHaveText('1');
  await page.locator('#search').fill('Alpha');
  await expect(page.locator('.track-row')).toHaveCount(1);
  await expect(page.locator('.track-row')).toContainText('Alpha');
  await page.locator('#search').fill('');
  await page.getByRole('button', { name: 'Actualiser : Source fictive — test UI', exact: true }).click();
  await expect.poll(() => mock.writes.length).toBe(1);
  expect(mock.writes[0]).toEqual({ path: '/api/sync', method: 'POST', body: { id: 'synthetic-source' } });
  await expect(page.locator('#sync-all')).toBeEnabled();
  await page.locator('#sync-all').click();
  await expect.poll(() => mock.writes.length).toBe(2);
  expect(mock.writes[1]).toEqual({ path: '/api/sync', method: 'POST', body: {} });
  await page.getByRole('button', { name: 'Retirer : Source fictive — test UI', exact: true }).click();
  await expect(page.locator('#remove-dialog')).toBeVisible();
  await screenshot(page, info, 'nonconnected-mock-only-dialog');
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(page.locator('#remove-dialog')).not.toBeVisible();
  expect(mock.writes).toHaveLength(2);
  await expect(page.locator('#source-count')).toHaveText('1');
  await screenshot(page, info, 'nonconnected-mock-only-library');
  await page.locator('#source-url').fill('https://example.invalid/another-demo.mp3');
  await page.locator('#add-source').click();
  await expect.poll(() => mock.writes.length).toBe(3);
  expect(mock.writes[2]).toEqual({ path: '/api/sources', method: 'POST', body: { url: 'https://example.invalid/another-demo.mp3' } });
  await expect(page.locator('#source-url')).toHaveValue('');
});

test('mock-only polling preserves focused range input', async ({ page }) => {
  await page.clock.install();
  const mock = await mockLibrary(page);
  await page.goto('/');
  const volume = page.locator('#volume');
  await expect(volume).toBeEnabled();
  await volume.focus();
  // Simulate an in-progress range drag: input fires, change has not committed yet.
  await volume.evaluate(input => { input.value = '37'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  const before = mock.polls();
  await page.clock.runFor(5100);
  await expect.poll(mock.polls).toBeGreaterThan(before);
  await expect(volume).toBeFocused();
  await expect(volume).toHaveValue('37');
  await expect(page.locator('#volume-value')).toHaveText('37%');
  expect(mock.writes).toHaveLength(0);
});

test('mock-only account and permission failures give actionable guidance', async ({ page }) => {
  const mock = await mockLibrary(page);
  mock.state.connection.state = 'auth_required';
  await page.goto('/');
  await expect(page.locator('#connection')).toContainText('Compte à vérifier');
  await expect(page.locator('#notice')).toContainText('Vérifiez le token du compte dédié');
  await expect(page.locator('#toggle')).toBeDisabled();
  await expect(page.locator('#add-source')).toBeEnabled();
  mock.state.connection.state = 'permission_denied';
  await page.reload();
  await expect(page.locator('#connection')).toContainText('Accès au salon refusé');
  await expect(page.locator('#notice')).toContainText('Voir le salon');
  expect(mock.writes).toHaveLength(0);
});
