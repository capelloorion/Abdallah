import { describe, expect, it } from 'vitest';
import { errorResponse } from './bff-json';

const TRACE = '0eb01' + 'f'.repeat(27);

describe('errorResponse', () => {
  it('is the api error shape: { error, trace_id } and the given status', async () => {
    const res = errorResponse('validation_error', 422, TRACE);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'validation_error', trace_id: TRACE });
  });

  it('adds extra fields, but they can never overwrite error or trace_id', async () => {
    const res = errorResponse('upstream_error', 502, TRACE, {
      target: 'api',
      error: 'something_else',
      trace_id: 'not-mine',
    });
    expect(await res.json()).toEqual({ target: 'api', error: 'upstream_error', trace_id: TRACE });
  });
});
