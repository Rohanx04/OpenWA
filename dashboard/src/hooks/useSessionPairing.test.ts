// The QR / pairing modal polls the QR route every five seconds. A poll that fails and cannot read the
// session's status either must not close the modal: the operator may be in the middle of typing a phone
// number, and the failure is the network's, not the session's.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../services/api.ts';

let rtl: typeof import('@testing-library/react');
let useSessionPairing: (typeof import('./useSessionPairing.ts'))['useSessionPairing'];
let sessionApi: (typeof import('../services/api.ts'))['sessionApi'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ useSessionPairing } = await import('./useSessionPairing.ts'));
  ({ sessionApi } = await import('../services/api.ts'));
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  rtl.cleanup();
});

const session = { id: 's1', name: 'main', status: 'qr_ready' } as unknown as Session;

/** Opens the modal for `s1`, lets the poll run once with GET /qr failing, and answers the status read as given. */
async function pollOnce(statusRead: () => Promise<Session>): Promise<boolean> {
  const api = sessionApi as unknown as {
    getQR: () => Promise<unknown>;
    get: () => Promise<Session>;
  };
  mock.restoreAll();
  mock.timers.reset();
  mock.method(api, 'getQR', () => Promise.reject(new Error('Failed to fetch')));
  mock.method(api, 'get', statusRead);
  mock.timers.enable({ apis: ['setInterval'] });
  const sessions = [session];
  const { result } = rtl.renderHook(() =>
    useSessionPairing({ sessions, sessionsRef: { current: sessions }, reloadSessions: async () => sessions }),
  );
  await rtl.act(async () => {
    await result.current.handleShowQR('s1');
  });
  assert.ok(result.current.qrData, 'the modal did not open');
  await rtl.act(async () => {
    mock.timers.tick(5000);
    await new Promise(resolve => setImmediate(resolve));
  });
  return result.current.qrData !== null;
}

test('the modal stays open when the QR poll and the status read both fail without an answer', async () => {
  assert.equal(await pollOnce(() => Promise.reject(new TypeError('Failed to fetch'))), true);
});

test('the modal stays open when the status read is refused for rate or fails on the server', async () => {
  for (const status of [429, 502]) {
    rtl.cleanup();
    assert.equal(
      await pollOnce(() => Promise.reject(Object.assign(new Error('refused'), { status }))),
      true,
      `a ${status} closed the modal`,
    );
  }
});

test('the modal closes when the session is gone or no longer starting', async () => {
  assert.equal(await pollOnce(() => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }))), false);
  rtl.cleanup();
  assert.equal(await pollOnce(() => Promise.resolve({ ...session, status: 'failed' } as Session)), false);
});

test('the modal stays open while the session is still initializing', async () => {
  assert.equal(await pollOnce(() => Promise.resolve({ ...session, status: 'authenticating' } as Session)), true);
});

/** Opens the modal for a session in `status`, runs one poll, and reports the modal and what the poll did. */
async function pollWithQr(status: string, getQR: () => Promise<unknown>, statusAtPoll = status) {
  const api = sessionApi as unknown as { getQR: () => Promise<unknown>; get: () => Promise<Session> };
  mock.restoreAll();
  mock.timers.reset();
  const getQrCalls = mock.method(api, 'getQR', getQR);
  mock.method(api, 'get', () => Promise.reject(new Error('the status is not read on this path')));
  mock.timers.enable({ apis: ['setInterval'] });
  const sessions = [{ ...session, status } as Session];
  const ref = { current: sessions };
  let reloads = 0;
  const { result } = rtl.renderHook(() =>
    useSessionPairing({
      sessions,
      sessionsRef: ref,
      reloadSessions: async () => {
        reloads++;
        return sessions;
      },
    }),
  );
  await rtl.act(async () => {
    await result.current.handleShowQR('s1');
  });
  assert.ok(result.current.qrData, 'the modal did not open');
  ref.current = [{ ...session, status: statusAtPoll } as Session];
  const callsBefore = getQrCalls.mock.callCount();
  await rtl.act(async () => {
    mock.timers.tick(5000);
    await new Promise(resolve => setImmediate(resolve));
  });
  return {
    qrData: result.current.qrData,
    pollCalls: getQrCalls.mock.callCount() - callsBefore,
    reloads,
  };
}

test('a poll refreshes the QR code while the session waits for a scan', async () => {
  const outcome = await pollWithQr('qr_ready', () => Promise.resolve({ qrCode: 'NEW-CODE', status: 'qr_ready' }));
  assert.equal(outcome.pollCalls, 1);
  assert.equal(outcome.qrData?.qrCode, 'NEW-CODE');
});

test('a poll that learns the session is ready closes the modal and reloads the list', async () => {
  const outcome = await pollWithQr('qr_ready', () => Promise.resolve({ qrCode: '', status: 'ready' }));
  assert.equal(outcome.qrData, null);
  assert.ok(outcome.reloads >= 1);
});

test('no QR is requested before the engine has produced one', async () => {
  const outcome = await pollWithQr('initializing', () => Promise.reject(new Error('400')));
  assert.equal(outcome.pollCalls, 0);
  assert.ok(outcome.qrData, 'the modal stays open for the push that carries the code');
});

test('a session that became ready closes the modal without a request', async () => {
  const outcome = await pollWithQr('qr_ready', () => Promise.resolve({ qrCode: 'X', status: 'qr_ready' }), 'ready');
  assert.equal(outcome.pollCalls, 0);
  assert.equal(outcome.qrData, null);
});
