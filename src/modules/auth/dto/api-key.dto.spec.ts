import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Repository } from 'typeorm';
import { ALLOWED_CHATS_MAX, ApiKeyResponseDto, CreateApiKeyDto, UpdateApiKeyDto } from './api-key.dto';
import { AuthService } from '../auth.service';
import type { ApiKey } from '../entities/api-key.entity';
import type { ApiKeyUsageTracker } from '../api-key-usage-tracker.service';

const property = (dto: object, name: string) =>
  Reflect.getMetadata('swagger/apiModelProperties', dto, name) as {
    description?: string;
    nullable?: boolean;
    minLength?: number;
    maxLength?: number;
    maxItems?: number;
  };

describe('API key DTO contract', () => {
  it('describes keyPrefix with the length the service stores', async () => {
    const repository = { create: (row: ApiKey) => row, save: (row: ApiKey) => Promise.resolve(row) };
    const service = new AuthService(repository as unknown as Repository<ApiKey>, {} as ApiKeyUsageTracker, {} as never);
    const { apiKey } = await service.createApiKey({ name: 'probe' });

    expect(property(ApiKeyResponseDto.prototype, 'keyPrefix').description).toContain(
      `First ${apiKey.keyPrefix.length} characters`,
    );
  });

  it('declares null as the way to clear expiresAt, the only empty value validation accepts', async () => {
    expect(property(UpdateApiKeyDto.prototype, 'expiresAt').nullable).toBe(true);

    const errors = async (expiresAt: unknown) =>
      (await validate(plainToInstance(UpdateApiKeyDto, { expiresAt }))).map(error => error.property);
    expect(await errors(null)).toEqual([]);
    expect(await errors('')).toEqual(['expiresAt']);
  });

  it.each([CreateApiKeyDto, UpdateApiKeyDto])('publishes the name length bounds %p validates', dto => {
    expect(property(dto.prototype, 'name')).toEqual(expect.objectContaining({ minLength: 3, maxLength: 100 }));
  });

  // @ArrayMaxSize is runtime-only: a client generated from the schema learns the bound from maxItems or not at all.
  it.each([CreateApiKeyDto, UpdateApiKeyDto])('publishes the allowedChats bound of %p', dto => {
    expect(property(dto.prototype, 'allowedChats').maxItems).toBe(ALLOWED_CHATS_MAX);
  });

  it.each([CreateApiKeyDto, UpdateApiKeyDto])('bounds the allowedChats list of %p', async dto => {
    // Search binds one SQL parameter per expanded id and a socket holds at most 4096 rooms, two address
    // forms per phone, so an unbounded list made search answer 500 and every subscribe refuse.
    const errors = async (count: number) =>
      (
        await validate(
          plainToInstance(dto, {
            name: 'probe',
            allowedChats: Array.from({ length: count }, (_, index) => `62811${String(index).padStart(7, '0')}`),
          }),
        )
      ).map(error => error.property);
    expect(await errors(ALLOWED_CHATS_MAX)).toEqual([]);
    expect(await errors(ALLOWED_CHATS_MAX + 1)).toEqual(['allowedChats']);
  });
});
