import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendProductDto } from '../../catalog/dto/send-product.dto';
import { ArchiveChatDto } from './archive-chat.dto';
import { DeleteChatDto } from './delete-chat.dto';
import { MarkChatReadDto } from './mark-chat-read.dto';
import { MarkChatUnreadDto } from './mark-chat-unread.dto';
import { MuteChatDto } from './mute-chat.dto';
import { PinChatDto } from './pin-chat.dto';
import { SubscribePresenceDto } from './presence.dto';
import { SendChatStateDto } from './send-chat-state.dto';

// The send routes store a chat id in an indexed column, and PostgreSQL refuses an index entry past about
// 2.7 KB, which used to surface as a 500 where SQLite stored the value. They bound it at 255, and so does
// every other request body that names a chat, so one limit holds across the API: a product send stores
// the id like the send routes, and a chat action hands it to the engine.
describe('chatId is bounded at 255 characters on the chat action bodies', () => {
  const exact = `${'1'.repeat(250)}@c.us`;
  const over = `${'1'.repeat(251)}@c.us`;

  it.each([
    ['ArchiveChatDto', ArchiveChatDto, { archive: true }],
    ['DeleteChatDto', DeleteChatDto, {}],
    ['MarkChatReadDto', MarkChatReadDto, {}],
    ['MarkChatUnreadDto', MarkChatUnreadDto, {}],
    ['MuteChatDto', MuteChatDto, {}],
    ['PinChatDto', PinChatDto, { pin: true }],
    ['SubscribePresenceDto', SubscribePresenceDto, {}],
    ['SendChatStateDto', SendChatStateDto, { state: 'typing' }],
    ['SendProductDto', SendProductDto, { productId: 'p1' }],
  ] as const)('%s', async (_name, Dto, rest) => {
    const constraintsOf = async (chatId: string): Promise<string[]> => {
      const errors = await validate(plainToInstance(Dto as new () => object, { ...rest, chatId }));
      return errors.filter(e => e.property === 'chatId').flatMap(e => Object.keys(e.constraints ?? {}));
    };
    expect(await constraintsOf(over)).toContain('maxLength');
    expect(await constraintsOf(exact)).not.toContain('maxLength');
  });
});
