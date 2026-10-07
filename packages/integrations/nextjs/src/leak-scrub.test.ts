import { describe, it, expect } from 'vitest';
import { resetRedactionMap } from 'varlock/env';
import { scrubLeakedSecrets } from './leak-scrub';

describe('scrubLeakedSecrets', () => {
  it('redacts values exempt from log redaction (redact=false)', () => {
    resetRedactionMap({
      config: {
        PRINTED_TOKEN: { value: 'printed-token-abcdef123', isSensitive: true, redact: false },
      },
    } as any);
    const scrubbed = scrubLeakedSecrets('const token = "printed-token-abcdef123";');
    expect(scrubbed).not.toContain('printed-token-abcdef123');
    expect(scrubbed).toContain('▒');
  });
});
