import { describe, expect, it } from 'vitest';
import { hasKey, loadEnv, redact } from './env.js';

const SRC = { ANTHROPIC_API_KEY: 'sk-ant-secret-123456', VOYAGE_API_KEY: 'pa-voyage-abcdef12', CLICK_DEBUG: '1' };

describe('env', () => {
  it('treats every key as optional and empty strings as unset', () => {
    expect(loadEnv({})).toEqual({});
    expect(loadEnv({ HYDRA_DB_API_KEY: '' }).HYDRA_DB_API_KEY).toBeUndefined();
  });

  it('hasKey reflects presence', () => {
    expect(hasKey('ANTHROPIC_API_KEY', SRC)).toBe(true);
    expect(hasKey('TYPESAFE_API_KEY', SRC)).toBe(false);
  });

  it('redacts secret values wherever they appear', () => {
    const line = `calling with Bearer ${SRC.ANTHROPIC_API_KEY} and key=${SRC.VOYAGE_API_KEY}; again ${SRC.ANTHROPIC_API_KEY}`;
    const out = redact(line, SRC);
    expect(out).toBe('calling with Bearer *** and key=***; again ***');
    expect(out).not.toContain('sk-ant');
  });

  it('does not redact non-secret config or short values', () => {
    expect(redact('debug=1', SRC)).toBe('debug=1');
    expect(redact('token 123', { ANTHROPIC_API_KEY: '123' })).toBe('token 123');
  });

  it('leaves text without secrets unchanged', () => {
    expect(redact('nothing here', SRC)).toBe('nothing here');
  });
});
