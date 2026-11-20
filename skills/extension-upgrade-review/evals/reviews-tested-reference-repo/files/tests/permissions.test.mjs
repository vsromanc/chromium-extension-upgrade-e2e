// 1.1.0 adds the "tabs" permission (install warning: "Read your browsing history").
// - Force-installed by policy: permissions are granted silently, stays enabled.
// - Normal (external) install: Chromium installs the update but disables the
//   extension until the user approves the new permission.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { launch, publish, stepper, waitFor } from './harness.mjs';

describe('permission increase, force-installed by policy', () => {
  const step = stepper(it);
  let x;
  before(async () => {
    await publish(['1.0.2']);
    x = await launch('permissions-force', { install: 'force' });
    await x.waitForVersion('1.0.2');
  });
  after(() => x?.close());

  step('updates to 1.1.0 and stays enabled with the new permission granted', async () => {
    await publish(['1.1.0']);
    assert.equal((await x.checkForUpdate()).status, 'update_available');
    await x.waitForVersion('1.1.0');
    const info = await x.internals();
    assert.equal(info.location, 'EXTERNAL_POLICY_DOWNLOAD');
    assert.deepEqual(info.disable_reasons, []);
    assert.ok(info.permissions.active.api.includes('tabs'), 'tabs granted');
  });
});

describe('permission increase, normal (external) install', () => {
  const step = stepper(it);
  let x;
  before(async () => {
    await publish(['1.0.2']);
    x = await launch('permissions-external', { install: 'external' });
    await x.waitForVersion('1.0.2');
  });
  after(() => x?.close());

  step('installed as a regular, enabled extension', async () => {
    const info = await x.internals();
    console.log('install location:', info.location, 'disable_reasons:', info.disable_reasons);
    assert.notEqual(info.location, 'EXTERNAL_POLICY_DOWNLOAD');
    assert.deepEqual(info.disable_reasons, []);
  });

  step('updates to 1.1.0 but is disabled pending permission approval', async () => {
    await publish(['1.1.0']);
    assert.equal((await x.checkForUpdate()).status, 'update_available');
    const info = await waitFor(async () => {
      const i = await x.internals();
      return i?.disable_reasons.includes('DISABLE_PERMISSIONS_INCREASE') && i;
    }, 'extension to be disabled for a permissions increase');
    assert.ok(!info.permissions.active.api.includes('tabs'), 'tabs not granted without approval');
    // While disabled, chrome://extensions-internals keeps reporting the old 1.0.2
    // object; the profile shows 1.1.0 is what's actually installed.
    console.log('extensions-internals still reports version', info.version);
    const saved = await waitFor(async () => {
      const s = await x.savedSettings();
      return s.Preferences?.manifest?.version === '1.1.0' && s;
    }, 'profile to record 1.1.0');
    assert.deepEqual(saved.installDirs, ['1.1.0_0']);
    assert.ok(saved.Preferences.pending_on_installed_event_dispatch_info, 'onInstalled(update) held until re-enabled');
  });
});
