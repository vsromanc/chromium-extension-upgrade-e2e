// Update arrives while an extension page is open. Chromium won't swap the
// extension out from under an active page; it fires runtime.onUpdateAvailable
// instead, and our service worker calls chrome.runtime.reload() to apply it.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { itemsAtSchema, launch, publish, SEED, stepper } from './harness.mjs';

describe('update while an extension page is open', () => {
  const step = stepper(it);
  let x;
  before(async () => {
    await publish(['1.0.0']);
    x = await launch('page-open');
    await x.waitForVersion('1.0.0');
    await x.waitForInstalledEvent('install');
    await x.addItems(...SEED);
  });
  after(() => x?.close());

  step('update is applied via onUpdateAvailable -> reload()', async () => {
    await publish(['1.0.1']);
    await x.ext(); // open test.html and keep it open
    const r = await x.checkForUpdate({ keepPageOpen: true });
    assert.equal(r.status, 'update_available');
    await x.waitForVersion('1.0.1');
  });

  step('onUpdateAvailable fired on 1.0.0 before the update was installed', async () => {
    const { data, events } = await x.waitForInstalledEvent('update', '1.0.1');
    const avail = events.findIndex((e) => e.type === 'updateAvailable' && e.newVersion === '1.0.1');
    const upd = events.findIndex((e) => e.reason === 'update' && e.version === '1.0.1');
    assert.ok(avail >= 0, 'onUpdateAvailable was dispatched');
    assert.equal(events[avail].version, '1.0.0', 'dispatched to the old version');
    assert.ok(avail < upd, 'before onInstalled(update)');
    assert.deepEqual(data.items, itemsAtSchema(2));
  });
});
