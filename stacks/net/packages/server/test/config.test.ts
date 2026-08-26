import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_ORIGINS, readConfig } from '../src/config.ts';

describe('readConfig port resolution', () => {
  it('defaults to 8531 with no environment at all', () => {
    expect(readConfig({})).toMatchObject({ host: '127.0.0.1', port: 8531 });
  });

  it('reads NET_SERVER_PORT ahead of PORT (ADR 0050 order)', () => {
    expect(readConfig({ NET_SERVER_PORT: '9000', PORT: '3000' }).port).toBe(9000);
    expect(readConfig({ PORT: '3000' }).port).toBe(3000);
  });

  it('throws on a bad port, naming the variable the operator supplied', () => {
    expect(() => readConfig({ NET_SERVER_PORT: 'NaN' })).toThrow(/NET_SERVER_PORT/);
    expect(() => readConfig({ PORT: '-1' })).toThrow(/PORT/);
    expect(() => readConfig({ NET_SERVER_PORT: '70000' })).toThrow(/<= 65535/);
  });
});

describe('readConfig allowed origins', () => {
  it('defaults to both localhost admin dev origins', () => {
    expect(readConfig({}).allowedOrigins).toEqual(DEFAULT_ALLOWED_ORIGINS);
  });

  it('splits NET_ALLOWED_ORIGINS on commas and trims empties', () => {
    expect(readConfig({ NET_ALLOWED_ORIGINS: 'http://a.example , http://b.example,' }).allowedOrigins).toEqual([
      'http://a.example',
      'http://b.example',
    ]);
  });
});
