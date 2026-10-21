import { sweepOrphanedFiles } from './orphan-sweep';

describe('sweepOrphanedFiles', () => {
  const PREFIX = 'status/';

  function fixture(initial: string[]) {
    let keys = initial;
    const deleted: string[] = [];
    const deleteFile = jest.fn((key: string): Promise<void> => {
      deleted.push(key);
      return Promise.resolve();
    });
    const storage = {
      iterateFiles: async function* (): AsyncGenerator<string> {
        await Promise.resolve();
        for (const key of keys) yield key;
      },
      deleteFile,
    };
    return {
      deleted,
      deleteFile,
      set: (next: string[]) => {
        keys = next;
      },
      sweep: (
        overrides: Partial<Parameters<typeof sweepOrphanedFiles>[0]> & {
          firstSeenAt: Map<string, number>;
          now: number;
        },
      ) =>
        sweepOrphanedFiles({
          storage,
          prefix: PREFIX,
          graceMs: 500,
          referencedAmong: () => Promise.resolve(new Set<string | undefined>()),
          onDeleteFailed: jest.fn(),
          ...overrides,
        }),
    };
  }

  it('never touches a file outside the prefix it owns', async () => {
    const f = fixture(['status/a.jpg', 'chat-media/b.jpg']);
    const removed = await f.sweep({ firstSeenAt: new Map(), now: 1000, graceMs: 0 });
    expect(removed).toBe(1);
    expect(f.deleted).toEqual(['status/a.jpg']);
  });

  it('deletes an unreferenced file only after the grace window has run from its first sighting', async () => {
    const f = fixture(['status/a.jpg']);
    const firstSeenAt = new Map<string, number>();
    expect(await f.sweep({ firstSeenAt, now: 1000 })).toBe(0);
    expect(firstSeenAt.get('status/a.jpg')).toBe(1000);
    expect(await f.sweep({ firstSeenAt, now: 1499 })).toBe(0);
    expect(await f.sweep({ firstSeenAt, now: 1500 })).toBe(1);
    expect(f.deleted).toEqual(['status/a.jpg']);
    expect(firstSeenAt.size).toBe(0);
  });

  it('drops the bookkeeping of a file that disappeared or became referenced between passes', async () => {
    const f = fixture(['status/gone.jpg', 'status/claimed.jpg']);
    const firstSeenAt = new Map<string, number>();
    await f.sweep({ firstSeenAt, now: 1000 });
    expect([...firstSeenAt.keys()].sort()).toEqual(['status/claimed.jpg', 'status/gone.jpg']);

    f.set(['status/claimed.jpg']);
    await f.sweep({
      firstSeenAt,
      now: 1100,
      referencedAmong: () => Promise.resolve(new Set<string | undefined>(['status/claimed.jpg'])),
    });
    expect(firstSeenAt.size).toBe(0);
  });

  it('reports a failed delete and retries the file on a later pass', async () => {
    const f = fixture(['status/a.jpg']);
    f.deleteFile.mockRejectedValueOnce(new Error('EBUSY'));
    const onDeleteFailed = jest.fn();
    const firstSeenAt = new Map<string, number>();
    await f.sweep({ firstSeenAt, now: 1000, graceMs: 0, onDeleteFailed });
    expect(onDeleteFailed).toHaveBeenCalledWith('status/a.jpg', expect.any(Error));
    expect(firstSeenAt.has('status/a.jpg')).toBe(true);
    expect(await f.sweep({ firstSeenAt, now: 1001, graceMs: 0, onDeleteFailed })).toBe(1);
  });

  it('asks which keys are referenced in chunks of the size it was given', async () => {
    const f = fixture(['status/1', 'status/2', 'status/3', 'status/4', 'status/5']);
    const referencedAmong = jest.fn((keys: string[]) => {
      void keys;
      return Promise.resolve(new Set<string | undefined>());
    });
    await f.sweep({ firstSeenAt: new Map(), now: 1000, chunkSize: 2, referencedAmong });
    expect(referencedAmong.mock.calls.map(([keys]) => keys.length)).toEqual([2, 2, 1]);
  });
});
