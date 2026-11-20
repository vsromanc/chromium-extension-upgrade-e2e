// Happy path: force-installed 1.0.0 -> publish 1.0.1 -> Chromium's updater installs it -> migration.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { itemsAtSchema, launch, publish, requests, SEED, stepper } from './harness.mjs';

describe('happy path: 1.0.0 -> 1.0.1 (force-installed)', () => {
  const step = stepper(it);
  let x;
  before(async () => {
    await publish(['1.0.0']);
    x = await launch('upgrade');
  });
  after(() => x?.close());

  step('force-installs 1.0.0 from the update server', async () => {
    await x.waitForVersion('1.0.0');
    const st = await x.waitForInstalledEvent('install');
    assert.equal(st.data.schema, 1);
  });

  step('seeds user data on 1.0.0', async () => {
    await x.addItems(...SEED);
    assert.deepEqual((await x.state()).data.items, itemsAtSchema(1));
    await x.closeExt();
  });

  step('picks up 1.0.1 after it is published', async () => {
    await publish(['1.0.1']);
    const r = await x.checkForUpdate();
    assert.equal(r.status, 'update_available');
    await x.waitForVersion('1.0.1');
  });

  step('migrated user data and recorded the update', async () => {
    const { data, events } = await x.waitForInstalledEvent('update', '1.0.1');
    assert.equal(data.schema, 2);
    assert.deepEqual(data.items, itemsAtSchema(2));
    assert.equal(events.find((e) => e.reason === 'update').previousVersion, '1.0.0');
  });

  step('downloaded both CRXs from the self-hosted server', async () => {
    const paths = (await requests()).map((r) => r.path);
    assert.ok(paths.includes('/crx/ext-1.0.0.crx'));
    assert.ok(paths.includes('/crx/ext-1.0.1.crx'));
  });
});
