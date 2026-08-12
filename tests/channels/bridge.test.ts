import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { ChannelBridge } from '../../src/channels/bridge';
import type { ChannelTransport, IncomingMessage } from '../../src/channels/types';
import type { Provider, ChatEvent, Message, ToolDefinition } from '../../src/providers/types';
import { MemoryStore } from '../../src/memory/store';
import { SkillStore } from '../../src/skills/store';
import { UnsupportedModelStore } from '../../src/providers/unsupported-models';

/**
 * A transport driven from the test: `deliver` pushes a message through the
 * bridge exactly as a real poll loop would, and `sent` records the replies.
 */
class FakeTransport implements ChannelTransport {
  readonly id = 'fake';
  readonly name = 'Fake';
  readonly sent: { chatId: string; text: string }[] = [];
  private handler?: (m: IncomingMessage) => Promise<void>;
  connectCalls = 0;

  async connect() {
    this.connectCalls += 1;
    return { identity: '@fake_bot' };
  }

  async receive(handler: (m: IncomingMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
    // Returns immediately; the test drives delivery itself.
  }

  async send(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }

  async deliver(message: Partial<IncomingMessage> & { text: string }): Promise<void> {
    await this.handler?.({
      chatId: '1',
      senderId: '123',
      ...message,
    });
  }
}

/** A provider that replies with a canned string, optionally requesting a tool first. */
function fakeProvider(reply: string, toolCall?: { name: string; arguments: string }): Provider {
  let issuedTool = false;
  return {
    id: 'fake',
    name: 'Fake',
    isAuthenticated: async () => true,
    login: async () => {},
    logout: async () => {},
    listModels: async () => ['fake-model'],
    async *chat(
      _model: string,
      _messages: Message[],
      _tools?: ToolDefinition[]
    ): AsyncIterable<ChatEvent> {
      if (toolCall && !issuedTool) {
        issuedTool = true;
        yield { type: 'tool_call', toolCall: { id: 't1', ...toolCall } };
        return;
      }
      yield { type: 'text', text: reply };
    },
  };
}

let stores: { unsupported: UnsupportedModelStore; memory: MemoryStore; skills: SkillStore };

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-bridge-'));
  stores = {
    unsupported: new UnsupportedModelStore(path.join(dir, 'unsupported.json')),
    memory: new MemoryStore(path.join(dir, 'memory')),
    skills: new SkillStore(path.join(dir, 'skills')),
  };
});

function makeBridge(
  transport: FakeTransport,
  overrides: { allowlist?: string[]; allowTools?: boolean; provider?: Provider } = {}
) {
  return new ChannelBridge({
    transport,
    provider: overrides.provider ?? fakeProvider('hello from the model'),
    model: 'fake-model',
    allowlist: overrides.allowlist ?? ['123'],
    allowTools: overrides.allowTools,
    stores,
    log: () => {},
  });
}

async function started(transport: FakeTransport, bridge: ChannelBridge) {
  await bridge.start(new AbortController().signal);
  return transport;
}

describe('ChannelBridge.start', () => {
  it('refuses to start with an empty allowlist, before touching the transport', async () => {
    const transport = new FakeTransport();
    await expect(
      makeBridge(transport, { allowlist: [] }).start(new AbortController().signal)
    ).rejects.toThrow(/No senders are allowed/);
    expect(transport.connectCalls).toBe(0);
  });

  it('connects when the allowlist is populated', async () => {
    const transport = new FakeTransport();
    await started(transport, makeBridge(transport));
    expect(transport.connectCalls).toBe(1);
  });
});

describe('ChannelBridge access control', () => {
  it('answers an allowed sender', async () => {
    const transport = new FakeTransport();
    await started(transport, makeBridge(transport));

    await transport.deliver({ senderId: '123', text: 'hi' });

    expect(transport.sent).toEqual([{ chatId: '1', text: 'hello from the model' }]);
  });

  it('says nothing at all to a sender who is not allowed', async () => {
    const transport = new FakeTransport();
    await started(transport, makeBridge(transport));

    await transport.deliver({ senderId: '999', text: 'hi' });

    expect(transport.sent).toEqual([]);
  });
});

describe('ChannelBridge commands', () => {
  it('answers /help without consulting the model', async () => {
    const transport = new FakeTransport();
    await started(transport, makeBridge(transport));

    await transport.deliver({ text: '/help' });

    expect(transport.sent[0].text).toContain('/new');
    expect(transport.sent[0].text).not.toContain('hello from the model');
  });

  it('/status reports the model and the tool policy', async () => {
    const transport = new FakeTransport();
    await started(transport, makeBridge(transport));

    await transport.deliver({ text: '/status' });

    expect(transport.sent[0].text).toContain('fake-model');
    expect(transport.sent[0].text).toContain('read-only');
  });

  it('/new discards the conversation so far', async () => {
    const transport = new FakeTransport();
    await started(transport, makeBridge(transport));

    await transport.deliver({ text: 'first' });
    await transport.deliver({ text: '/status' });
    expect(transport.sent.at(-1)?.text).toContain('Turns:  1');

    await transport.deliver({ text: '/new' });
    await transport.deliver({ text: '/status' });
    expect(transport.sent.at(-1)?.text).toContain('Turns:  0');
  });

  it('keeps separate conversations per chat', async () => {
    const transport = new FakeTransport();
    await started(transport, makeBridge(transport));

    await transport.deliver({ chatId: 'a', text: 'one' });
    await transport.deliver({ chatId: 'a', text: 'two' });
    await transport.deliver({ chatId: 'b', text: '/status' });

    expect(transport.sent.at(-1)?.text).toContain('Turns:  0');
  });

  it('ignores a blank message rather than sending an empty turn', async () => {
    const transport = new FakeTransport();
    await started(transport, makeBridge(transport));

    await transport.deliver({ text: '   ' });

    expect(transport.sent).toEqual([]);
  });
});

describe('ChannelBridge tool policy', () => {
  const writeCall = {
    name: 'write_file',
    arguments: JSON.stringify({ path: 'evidence.txt', content: 'written remotely' }),
  };

  it('declines tool calls by default and says so in the reply', async () => {
    const transport = new FakeTransport();
    await started(
      transport,
      makeBridge(transport, { provider: fakeProvider('done', writeCall) })
    );

    await transport.deliver({ text: 'write a file' });

    expect(transport.sent[0].text).toContain('Declined');
    expect(transport.sent[0].text).toContain('read-only');
  });

  it('does not add the warning when nothing was declined', async () => {
    const transport = new FakeTransport();
    await started(transport, makeBridge(transport));

    await transport.deliver({ text: 'hi' });

    expect(transport.sent[0].text).not.toContain('Declined');
  });

  it('reports auto-approval in /status when --allow-tools is set', async () => {
    const transport = new FakeTransport();
    await started(transport, makeBridge(transport, { allowTools: true }));

    await transport.deliver({ text: '/status' });

    expect(transport.sent[0].text).toContain('auto-approved');
  });
});

describe('ChannelBridge serialisation', () => {
  it('handles two messages in the same chat one at a time', async () => {
    const transport = new FakeTransport();
    await started(transport, makeBridge(transport));

    // Both dispatched before either is awaited — the queue must still order them.
    await Promise.all([
      transport.deliver({ text: 'first' }),
      transport.deliver({ text: 'second' }),
    ]);

    await transport.deliver({ text: '/status' });
    expect(transport.sent.at(-1)?.text).toContain('Turns:  2');
  });
});
