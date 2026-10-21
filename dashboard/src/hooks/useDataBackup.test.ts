// The backup export saves a file with every integration instance's secrets in plaintext, so an export
// still in flight when the operator signs out must not save it over the login form. The replace-all
// import asks before it replaces anything and again before it stops live engines.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import type { useDataBackup as useDataBackupFn } from './useDataBackup.ts';
import type { ToastContext as ToastContextType } from './useToast.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let useDataBackup: typeof useDataBackupFn;
let ToastContext: typeof ToastContextType;

// Answer of the export route, per test; a pending one is an export still in flight.
let exportAnswer: Promise<Response> = new Promise(() => {});
const saved: HTMLAnchorElement[] = [];
// Answers of the import route in order, and what it was sent.
let importAnswers: Response[] = [];
const importBodies: Array<Record<string, unknown>> = [];
const toastLog: Array<{ kind: string; title: string; detail?: string }> = [];
let i18nT: (key: string, options?: Record<string, unknown>) => string;
let createElementOriginal: typeof document.createElement;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function dump(extra: Record<string, unknown> = {}): Response {
  return json({ exportedAt: '2026-10-09T10:00:00.000Z', dataDbType: 'sqlite', tables: {}, counts: {}, ...extra });
}

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  createElementOriginal = document.createElement;
  const { i18nReady, default: i18n } = await import('../i18n/index.ts');
  await i18nReady;
  i18nT = (key, options) => i18n.t(key, options) as string;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/infra/import-data')) {
      importBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return Promise.resolve(importAnswers.shift() ?? json({ imported: true, counts: {}, warnings: [] }, 201));
    }
    return url.endsWith('/api/infra/export-data')
      ? exportAnswer
      : Promise.resolve(new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
  };
  URL.createObjectURL = () => 'blob:backup';
  URL.revokeObjectURL = () => {};
  rtl = await import('@testing-library/react');
  ({ useDataBackup } = await import('./useDataBackup.ts'));
  ({ ToastContext } = await import('./useToast.ts'));
});

afterEach(() => {
  rtl.cleanup();
  saved.length = 0;
  exportAnswer = new Promise(() => {});
  window.sessionStorage.removeItem('openwa_api_key');
  document.createElement = createElementOriginal;
  importAnswers = [];
  importBodies.length = 0;
  toastLog.length = 0;
});

function renderBackup() {
  const noop = () => {};
  const record = (kind: string) => (title: string, detail?: string) => void toastLog.push({ kind, title, detail });
  const value = {
    toasts: [],
    addToast: noop,
    removeToast: noop,
    success: record('success'),
    error: record('error'),
    warning: record('warning'),
    info: record('info'),
  };
  const wrapper = ({ children }: { children: ReactNode }) => createElement(ToastContext.Provider, { value }, children);
  // Record each file the hook saves by capturing the link it clicks, instead of letting jsdom navigate.
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const element = createElementOriginal.call(document, tag, options);
    if (tag === 'a') (element as HTMLAnchorElement).click = () => void saved.push(element as HTMLAnchorElement);
    return element;
  }) as typeof document.createElement;
  return rtl.renderHook(() => useDataBackup(), { wrapper });
}

test('an export that completes while signed in saves the backup file', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  exportAnswer = Promise.resolve(dump());
  const { result } = renderBackup();
  await rtl.act(() => result.current.exportBackup());
  assert.deepEqual(
    saved.map(link => link.download),
    ['openwa-backup-2026-10-09.json'],
  );
});

test('an export answered after sign-out saves no file', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  let answer!: (response: Response) => void;
  exportAnswer = new Promise<Response>(resolve => (answer = resolve));
  const { result } = renderBackup();
  const exporting = rtl.act(() => result.current.exportBackup());
  window.sessionStorage.removeItem('openwa_api_key');
  answer(dump());
  await exporting;
  assert.deepEqual(saved, [], 'a backup of the whole database was saved after the sign-out');
});

test('an export that dropped inline media warns that the archive restores without those attachments', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  exportAnswer = Promise.resolve(dump({ omittedInlineMedia: { messages: 2, messageBatches: 1 } }));
  const { result } = renderBackup();
  await rtl.act(() => result.current.exportBackup());
  assert.equal(saved.length, 1);
  assert.deepEqual(toastLog, [
    {
      kind: 'warning',
      title: i18nT('infrastructure.migration.exportPartialTitle'),
      detail: i18nT('infrastructure.migration.exportPartial', { count: 3 }),
    },
  ]);
});

// The import prompts go through window.confirm: record each message and answer from a script.
const backupFile = (body: unknown): File =>
  new File([typeof body === 'string' ? body : JSON.stringify(body)], 'b.json');

function answerConfirms(...answers: boolean[]): string[] {
  const asked: string[] = [];
  window.confirm = (message?: string) => {
    asked.push(String(message));
    return answers.shift() ?? false;
  };
  return asked;
}

test('an import the operator declines at the row-count prompt sends nothing', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  const asked = answerConfirms(false);
  const { result } = renderBackup();
  await rtl.act(() => result.current.importBackup(backupFile({ tables: { sessions: [{ id: 'a' }, { id: 'b' }] } })));
  assert.deepEqual(asked, [i18nT('infrastructure.migration.importConfirm', { rows: 2 })]);
  assert.equal(importBodies.length, 0);
  assert.equal(result.current.migrating, false);
});

test('a file that is not JSON, or holds no tables, is refused before any prompt', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  const asked = answerConfirms(true, true);
  const { result } = renderBackup();
  await rtl.act(() => result.current.importBackup(backupFile('not json')));
  await rtl.act(() => result.current.importBackup(backupFile({ exportedAt: 'x' })));
  assert.deepEqual(asked, []);
  assert.equal(importBodies.length, 0);
  assert.deepEqual(
    toastLog.map(toast => [toast.kind, toast.detail]),
    [
      ['error', i18nT('infrastructure.migration.invalidFile')],
      ['error', i18nT('infrastructure.migration.invalidFile')],
    ],
  );
});

test('a confirmed import posts the tables and reports success', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  answerConfirms(true);
  const { result } = renderBackup();
  await rtl.act(() => result.current.importBackup(backupFile({ tables: { sessions: [{ id: 'a' }] } })));
  assert.deepEqual(importBodies, [{ tables: { sessions: [{ id: 'a' }] } }]);
  assert.deepEqual(toastLog, [
    { kind: 'success', title: i18nT('infrastructure.migration.importOk'), detail: undefined },
  ]);
});

const orphanRefusal = (): Response =>
  json(
    {
      statusCode: 409,
      message: 'Stop these sessions first: s1',
      error: 'Conflict',
      code: 'IMPORT_WOULD_ORPHAN_ENGINES',
    },
    409,
  );

test('an orphan-engine refusal asks, and retries once with stopOrphans only when the operator agrees', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  importAnswers = [orphanRefusal()];
  const asked = answerConfirms(true, true);
  const { result } = renderBackup();
  await rtl.act(() => result.current.importBackup(backupFile({ tables: { sessions: [{ id: 'a' }] } })));
  assert.equal(asked.length, 2);
  assert.equal(asked[1], 'Stop these sessions first: s1');
  assert.deepEqual(
    importBodies.map(body => body.stopOrphans),
    [undefined, true],
  );
  assert.equal(toastLog.at(-1)?.kind, 'success');
});

test('declining the orphan-engine prompt leaves the engines and the data alone', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  importAnswers = [orphanRefusal()];
  answerConfirms(true, false);
  const { result } = renderBackup();
  await rtl.act(() => result.current.importBackup(backupFile({ tables: { sessions: [{ id: 'a' }] } })));
  assert.equal(importBodies.length, 1);
  assert.deepEqual(toastLog, [
    { kind: 'error', title: i18nT('infrastructure.migration.importFailed'), detail: 'Stop these sessions first: s1' },
  ]);
});

test('a conflict with another code, or none, is never offered the destructive retry', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  importAnswers = [
    json({ statusCode: 409, message: 'An import is already running', code: 'IMPORT_ALREADY_RUNNING' }, 409),
    json({ statusCode: 409, message: 'Conflict' }, 409),
  ];
  const asked = answerConfirms(true, true, true, true);
  const { result } = renderBackup();
  await rtl.act(() => result.current.importBackup(backupFile({ tables: { sessions: [{ id: 'a' }] } })));
  await rtl.act(() => result.current.importBackup(backupFile({ tables: { sessions: [{ id: 'a' }] } })));
  assert.equal(asked.length, 2, 'only the two row-count prompts');
  assert.equal(importBodies.length, 2);
  assert.deepEqual(
    toastLog.map(toast => toast.kind),
    ['error', 'error'],
  );
});

test('a backup over the request body cap gets the actionable message, not a bare Payload Too Large', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  importAnswers = [json({ statusCode: 413, message: 'Payload Too Large' }, 413)];
  answerConfirms(true);
  const { result } = renderBackup();
  await rtl.act(() => result.current.importBackup(backupFile({ tables: { sessions: [{ id: 'a' }] } })));
  assert.deepEqual(toastLog, [
    {
      kind: 'error',
      title: i18nT('infrastructure.migration.importFailed'),
      detail: i18nT('infrastructure.migration.importTooLarge'),
    },
  ]);
});
