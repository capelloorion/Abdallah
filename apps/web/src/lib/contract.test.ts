import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { askStream, type StreamHandlers } from './chat-client';
import { createConversation, getConversation, listConversations } from './conversations-client';
import { sseStreamFromFrames } from './sse';
import {
  ASK_MOCK_CITATIONS,
  askStreamErrorFrames,
  askStreamFrames,
  conversationCreatedFixture,
  conversationDetailFixture,
  conversationFixtures,
  conversationListFixture,
} from '@/mocks/conversations';

/**
 * Contract checks (web 3.1). The fixtures are typed from the generated contract at compile time;
 * these tests prove the other direction: what the api's contract describes is what the browser
 * clients accept, so switching `MOCK_UPSTREAM` off cannot change the shapes the UI sees.
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const asFetch = (res: Response) => vi.fn(async () => res) as unknown as typeof fetch;

describe('the mock fixtures are accepted by the browser clients', () => {
  it('the list fixture', async () => {
    const fixture = conversationListFixture();
    const result = await listConversations(undefined, asFetch(json(fixture)));
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.map((c) => c.id)).toEqual(fixture.items.map((c) => c.id));
    expect(result.data.map((c) => c.title)).toEqual(fixture.items.map((c) => c.title));
    expect(result.data).toHaveLength(fixture.count);
  });

  it('the created-conversation fixture', async () => {
    const fixture = conversationCreatedFixture();
    const result = await createConversation(undefined, asFetch(json(fixture, 201)));
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.id).toBe(fixture.id);
    expect(result.data.title).toBe(fixture.title);
  });

  it.each(conversationFixtures.map((c) => [c.title, c.id] as const))(
    'the detail fixture "%s"',
    async (_title, id) => {
      const fixture = conversationDetailFixture(id)!;
      const result = await getConversation(id, undefined, asFetch(json(fixture)));
      if (!result.ok) throw new Error('expected ok');
      expect(result.data.messages.map((m) => m.text)).toEqual(
        fixture.messages.map((m) => m.content),
      );
      expect(result.data.messages.map((m) => m.role)).toEqual(fixture.messages.map((m) => m.role));
      const cited = fixture.messages.map((m) => m.citations ?? []);
      expect(result.data.messages.map((m) => m.citations ?? [])).toEqual(cited);
      expect(result.data.truncated).toBe(fixture.truncated);
    },
  );
});

describe('the mock stream frames are accepted by the stream client', () => {
  function handlers() {
    const seen = {
      sources: [] as unknown[],
      text: '',
      done: null as unknown,
      error: null as unknown,
    };
    const h: StreamHandlers = {
      onSources: (c) => seen.sources.push(c),
      onToken: (t) => (seen.text += t),
      onDone: (d) => (seen.done = d),
      onError: (e) => (seen.error = e),
    };
    return { seen, h };
  }
  const streamOf = (frames: string[]) =>
    asFetch(
      new Response(sseStreamFromFrames(frames), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

  it('a complete answer', async () => {
    const { seen, h } = handlers();
    await askStream('/api/v1/conversations/x/ask/stream', 'q', h, {
      fetchImpl: streamOf(askStreamFrames),
    });
    expect(seen.sources).toEqual([ASK_MOCK_CITATIONS]);
    expect(seen.text).toContain('The trace id is minted by the BFF [1]');
    expect(seen.done).toEqual({
      citations: ASK_MOCK_CITATIONS,
      inputTokens: 42,
      outputTokens: 24,
    });
    expect(seen.error).toBeNull();
  });

  it('an answer cut off by an error frame', async () => {
    const { seen, h } = handlers();
    await askStream('/api/v1/conversations/x/ask/stream', 'q', h, {
      fetchImpl: streamOf(askStreamErrorFrames),
    });
    expect(seen.sources).toEqual([ASK_MOCK_CITATIONS]);
    expect(seen.done).toBeNull();
    expect(seen.error).toMatchObject({ code: 'timeout' });
  });
});

describe('docs/reference/openapi.json (the api contract the web types are generated from)', () => {
  const spec = JSON.parse(
    readFileSync(join(__dirname, '../../../../docs/reference/openapi.json'), 'utf8'),
  ) as {
    paths: Record<
      string,
      Record<string, { description?: string; responses?: Record<string, unknown> }>
    >;
  };

  it('describes the three conversation routes and the ask routes the BFF mirrors', () => {
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/v1/conversations',
        '/v1/conversations/{conversation_id}',
        '/v1/conversations/{conversation_id}/ask/stream',
      ]),
    );
  });

  it('names every field the mock stream frames carry in the api description of the stream', () => {
    // The frames are not a JSON schema, so this ties the mock field names to the api's own words.
    const text = JSON.stringify(spec.paths['/v1/conversations/{conversation_id}/ask/stream'].post);
    const fields = new Set<string>();
    for (const frame of [...askStreamFrames, ...askStreamErrorFrames]) {
      const data = frame
        .split('\n')
        .find((l) => l.startsWith('data: '))!
        .slice('data: '.length);
      for (const key of Object.keys(JSON.parse(data))) fields.add(key);
    }
    expect([...fields].sort()).toEqual(
      ['citations', 'count', 'error_kind', 'input_tokens', 'output_tokens', 'text'].sort(),
    );
    for (const field of fields) expect(text).toContain(field);
  });

  it('documents every frame of the answer stream that ask-frames.ts types', () => {
    const op = spec.paths['/v1/conversations/{conversation_id}/ask/stream'].post;
    const text = JSON.stringify(op);
    for (const frame of ['sources', 'token', 'done', 'error']) {
      expect(text).toContain('`' + frame + '`');
    }
  });

  it('documents the failures the BFF relays for this route', () => {
    const responses = spec.paths['/v1/conversations/{conversation_id}/ask/stream'].post.responses!;
    for (const status of ['404', '413', '429', '503'])
      expect(Object.keys(responses)).toContain(status);
  });
});
