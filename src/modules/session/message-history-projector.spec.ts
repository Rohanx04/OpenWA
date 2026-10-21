import 'reflect-metadata';
import { DataSource, Repository } from 'typeorm';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { Session } from './entities/session.entity';
import type { LoggerService } from '../../common/services/logger.service';
import type { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { persistHistoryMessages } from './message-history-projector';

// A revoke tombstone from a history sync names the chat in the neutral dialect, while a row a REST send
// wrote keeps the chat id as the caller wrote it.
describe('persistHistoryMessages revokes', () => {
  let ds: DataSource;
  let repo: Repository<Message>;
  const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as unknown as LoggerService;

  const stored = (chatId: string, waMessageId = 'W1') =>
    repo.insert({
      sessionId: 's1',
      waMessageId,
      chatId,
      from: 'me@c.us',
      to: chatId,
      body: 'secret text',
      type: 'text',
      direction: MessageDirection.OUTGOING,
      timestamp: 10,
    });

  const tombstone = (chatId: string): IncomingMessage => ({
    id: 'W1',
    chatId,
    from: 'me@c.us',
    to: chatId,
    body: '',
    type: 'revoked',
    timestamp: 5,
    fromMe: true,
    isGroup: false,
    kind: 'individual',
  });

  const run = (messages: IncomingMessage[]) =>
    persistHistoryMessages(repo, undefined, 's1', messages, logger, () => true);

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
    });
    await ds.initialize();
    repo = ds.getRepository(Message);
  });
  afterEach(() => ds.destroy());

  it('clears a row stored under the other dialect of the same chat', async () => {
    await stored('628111@s.whatsapp.net');

    const cleared = await run([tombstone('628111@c.us')]);

    const row = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'W1' });
    expect(row).toMatchObject({ type: 'revoked', body: '', chatId: '628111@s.whatsapp.net' });
    expect(cleared.map(m => m.id)).toEqual(['W1']);
  });

  it('leaves a row of another chat alone', async () => {
    await stored('120363000000000001@g.us');

    const cleared = await run([tombstone('628111@c.us')]);

    const row = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'W1' });
    expect(row).toMatchObject({ type: 'text', body: 'secret text' });
    expect(cleared).toEqual([]);
  });
});
