// Bad updates must be rejected without breaking the installed version, and the
// extension must recover once a good build is published.
//
// requestUpdateCheck() backs off for ~5h after any check that doesn't end in an
// install, and the periodic updater runs at most every 30s (release clamp) and
// proved unreliable here. So after the first failure we restart the browser on
// the same profile: Chromium checks for updates at startup, and the backoff is
// in-memory. A browser restart is also the most common way real users update.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { itemsAtSchema, launch, publish, requests, SEED, sleep, stepper, waitForRequest } from './harness.mjs';

const SETTLE_MS = 5000; // time for Chromium to (fail to) install after a download

describe('bad updates are rejected; recovers when a good build appears', () => {
  const step = stepper(it);
  let x;
  const assertStillOn100 = async () => {
    const info = await x.internals();
    assert.equal(info.version, '1.0.0');
    assert.deepEqual(info.disable_reasons, []);
    const { data } = await x.state();
    assert.deepEqual(data.items, itemsAtSchema(1), 'user data untouched');
    await x.closeExt();
  };

  before(async () => {
    await publish(['1.0.0']);
    x = await launch('failures');
    await x.waitForVersion('1.0.0');
    await x.waitForInstalledEvent('install');
    await x.addItems(...SEED);
  });
  after(() => x?.close());

  step('CRX signed with a different key is rejected', async () => {
    const since = (await requests()).length;
    await publish(['ext-1.0.3-evil.crx']);
    assert.equal((await x.checkForUpdate()).status, 'update_available');
    await waitForRequest((r) => r.path === '/crx/ext-1.0.3-evil.crx', 'evil CRX download', since);
    await sleep(SETTLE_MS);
    await assertStillOn100();
  });

  step('truncated (corrupt) CRX is rejected', async () => {
    const since = (await requests()).length;
    await publish(['1.0.1'], 'corrupt');
    await x.restart();
    await waitForRequest((r) => r.path === '/crx/ext-1.0.1.crx' && r.mode === 'corrupt', 'corrupt CRX download', since);
    await sleep(SETTLE_MS);
    await assertStillOn100();
  });

  step('update server down (503) changes nothing', async () => {
    const since = (await requests()).length;
    await publish(['1.0.1'], 'down');
    await x.restart();
    await waitForRequest((r) => r.path === '/updates.xml' && r.mode === 'down', 'update check during outage', since);
    await sleep(SETTLE_MS);
    await assertStillOn100();
  });

  step('recovers on the next browser start once 1.0.1 is served properly', async () => {
    await publish(['1.0.1']);
    await x.restart();
    await x.waitForVersion('1.0.1');
    const { data } = await x.waitForInstalledEvent('update', '1.0.1');
    assert.deepEqual(data.items, itemsAtSchema(2));
  });
});

describe('publishing a lower version is ignored', () => {
  const step = stepper(it);
  let x;
  before(async () => {
    await publish(['1.0.1']);
    x = await launch('downgrade');
    await x.waitForVersion('1.0.1');
  });
  after(() => x?.close());

  step('update check reports no_update and nothing is downloaded', async () => {
    const since = (await requests()).length;
    await publish(['1.0.0']);
    const r = await x.checkForUpdate();
    assert.equal(r.status, 'no_update');
    await sleep(2000);
    assert.equal(await x.installedVersion(), '1.0.1');
    assert.ok(!(await requests()).slice(since).some((r) => r.path.endsWith('.crx')));
  });
});
