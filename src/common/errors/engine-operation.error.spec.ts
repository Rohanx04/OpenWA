import { BadGatewayException, ConflictException, HttpStatus, NotFoundException } from '@nestjs/common';
import { toEngineClientError, ENGINE_OPERATION_FAILED_MESSAGE } from './engine-operation.error';

describe('toEngineClientError', () => {
  it('maps a raw Error to a 502 Bad Gateway with the generic diagnostic message', () => {
    const mapped = toEngineClientError(new Error('Evaluation failed: Cannot read properties of undefined'));
    expect(mapped).toBeInstanceOf(BadGatewayException);
    expect(mapped.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect(mapped.message).toBe(ENGINE_OPERATION_FAILED_MESSAGE);
  });

  it('maps a primitive-string throw (whatsapp-web.js sometimes throws a bare string) to 502', () => {
    const mapped = toEngineClientError('some engine string');
    expect(mapped).toBeInstanceOf(BadGatewayException);
    expect(mapped.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
  });

  it('does NOT leak the raw error text into the client-facing message', () => {
    const mapped = toEngineClientError(new Error('internal-store-pointer 0xDEADBEEF'));
    expect(mapped.message).not.toMatch(/0xDEADBEEF/);
  });

  it('passes an existing HttpException through unchanged (status preserved)', () => {
    const notReady = new ConflictException('Session is not connected.');
    expect(toEngineClientError(notReady)).toBe(notReady);

    const notFound = new NotFoundException('Message not found');
    expect(toEngineClientError(notFound)).toBe(notFound);
  });
});
