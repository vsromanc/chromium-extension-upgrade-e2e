// Several versions in one update manifest. Chromium walks the <app> entries in
// document order and takes the FIRST one newer than what's installed, one
// install per update check. So the order of the list decides the behaviour.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { itemsAtSchema, launch, publish, requests, SEED, stepper } from './harness.mjs';

describe('manifest lists [1.0.1, 1.0.2] (oldest first): steps one version per check', () => {
  const step = stepper(it);
  let x;
  before(async () => {
    await publish(['1.0.0']);
    x = await launch('versions-ascending');
    await x.waitForVersion('1.0.0');
    await x.waitForInstalledEvent('install');
    await x.addItems(...SEED);
  });
  after(() => x?.close());

  step('first check installs 1.0.1, not the newest', async () => {
    await publish(['1.0.1', '1.0.2']);
    const r = await x.checkForUpdate();
    assert.deepEqual(r, { status: 'update_available', version: '1.0.1' });
    await x.waitForVersion('1.0.1');
    const { data } = await x.waitForInstalledEvent('update', '1.0.1');
    assert.deepEqual(data.items, itemsAtSchema(2));
  });

  step('second check installs 1.0.2', async () => {
    // A successful install resets requestUpdateCheck()'s backoff, so this isn't throttled.
    const r = await x.checkForUpdate();
    assert.deepEqual(r, { status: 'update_available', version: '1.0.2' });
    await x.waitForVersion('1.0.2');
    const { data, events } = await x.waitForInstalledEvent('update', '1.0.2');
    assert.deepEqual(data.items, itemsAtSchema(3));
    const updates = events.filter((e) => e.reason === 'update').map((e) => `${e.previousVersion}->${e.version}`);
    assert.deepEqual(updates, ['1.0.0->1.0.1', '1.0.1->1.0.2']);
  });
});

describe('manifest lists [1.0.2, 1.0.1] (newest first): jumps straight to 1.0.2', () => {
  const step = stepper(it);
  let x;
  before(async () => {
    await publish(['1.0.0']);
    x = await launch('versions-descending');
    await x.waitForVersion('1.0.0');
    await x.waitForInstalledEvent('install');
    await x.addItems(...SEED);
  });
  after(() => x?.close());

  step('one check installs 1.0.2 directly', async () => {
    await publish(['1.0.2', '1.0.1']);
    const r = await x.checkForUpdate();
    assert.deepEqual(r, { status: 'update_available', version: '1.0.2' });
    await x.waitForVersion('1.0.2');
  });

  step('both migrations ran in one update (schema 1 -> 3)', async () => {
    const { data, events } = await x.waitForInstalledEvent('update', '1.0.2');
    assert.equal(data.schema, 3);
    assert.deepEqual(data.items, itemsAtSchema(3));
    const updates = events.filter((e) => e.reason === 'update').map((e) => `${e.previousVersion}->${e.version}`);
    assert.deepEqual(updates, ['1.0.0->1.0.2']);
  });

  step('1.0.1 was never downloaded', async () => {
    assert.ok(!(await requests()).some((r) => r.path === '/crx/ext-1.0.1.crx'));
  });
});
