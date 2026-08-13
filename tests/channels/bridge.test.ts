import { describe, it, expect, afterEach, vi } from 'vitest';
import { ChannelBridge } from '../../src/channels/bridge';
import type { ChannelTransport, IncomingMessage } from '../../src/channels/types';
import type { Provider, ChatEvent, Message, ToolDefinition } from '../../src/providers/types';
import { GatewayClient } from '../../src/gateway/client';
import { startHarness, type GatewayHarness } from '../helpers/gateway-harness';

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

let harness: GatewayHarness | undefined;
let extraClients: GatewayClient[] = [];

afterEach(async () => {
  for (const client of extraClients.splice(0)) await client.close().catch(() => {});
  await harness?.close();
  harness = undefined;
});

/**
 * A bridge wired to a real gateway, connected as a channel — which is to say
 * with canApprove false, exactly as `robin serve` connects it.
 */
async function makeBridge(
  transport: FakeTransport,
  overrides: { allowlist?: string[]; allowTools?: boolean; provider?: Provider } = {}
): Promise<ChannelBridge> {
  const provider = overrides.provider ?? fakeProvider('hello from the model');
  harness = await startHarness({ providers: [provider] });
  const client = await harness.connect({ kind: 'channel', canApprove: false });

  return new ChannelBridge({
    transport,
    client,
    providerId: provider.id,
    model: 'fake-model',
    allowlist: overrides.allowlist ?? ['123'],
    allowTools: overrides.allowTools,
    log: () => {},
  });
}

async function started(
  transport: FakeTransport,
  bridge: ChannelBridge
): Promise<FakeTransport> {
  await bridge.start(new AbortController().signal);
  return transport;
}

describe('ChannelBridge.start', () => {
  it('refuses to start with an empty allowlist, before touching the transport', async () => {
    const transport = new FakeTransport();
    const bridge = await makeBridge(transport, { allowlist: [] });

    await expect(bridge.start(new AbortController().signal)).rejects.toThrow(
      /No senders are allowed/
    );
    expect(transport.connectCalls).toBe(0);
  });

  it('connects when the allowlist is populated', async () => {
    const transport = new FakeTransport();
    await started(transport, await makeBridge(transport));
    expect(transport.connectCalls).toBe(1);
  });
});

describe('ChannelBridge access control', () => {
  it('answers an allowed sender', async () => {
    const transport = new FakeTransport();
    await started(transport, await makeBridge(transport));

    await transport.deliver({ senderId: '123', text: 'hi' });

    expect(transport.sent).toEqual([{ chatId: '1', text: 'hello from the model' }]);
  });

  it('says nothing at all to a sender who is not allowed', async () => {
    const transport = new FakeTransport();
    await started(transport, await makeBridge(transport));

    await transport.deliver({ senderId: '999', text: 'hi' });

    expect(transport.sent).toEqual([]);
  });

  // The allowlist is the bridge's own responsibility and has to be settled
  // before anything reaches the gateway — a refused sender must not be able to
  // create a session, let alone run a turn.
  it('refuses before the gateway is asked for anything', async () => {
    const transport = new FakeTransport();
    const bridge = await makeBridge(transport);
    await started(transport, bridge);
    const request = vi.spyOn(harness!.client, 'request');

    await transport.deliver({ senderId: '999', text: 'hi' });

    expect(request).not.toHaveBeenCalled();
    expect(harness!.sessions.list()).toHaveLength(1); // only the harness's own
  });
});

describe('ChannelBridge commands', () => {
  it('answers /help without consulting the model', async () => {
    const transport = new FakeTransport();
    await started(transport, await makeBridge(transport));

    await transport.deliver({ text: '/help' });

    expect(transport.sent[0].text).toContain('/new');
    expect(transport.sent[0].text).not.toContain('hello from the model');
  });

  it('/status reports the model and the tool policy', async () => {
    const transport = new FakeTransport();
    await started(transport, await makeBridge(transport));

    await transport.deliver({ text: 'first' });
    await transport.deliver({ text: '/status' });

    expect(transport.sent.at(-1)?.text).toContain('fake-model');
    expect(transport.sent.at(-1)?.text).toContain('asked at a terminal');
  });

  it('/status before any message says there is no conversation yet', async () => {
    const transport = new FakeTransport();
    await started(transport, await makeBridge(transport));

    await transport.deliver({ text: '/status' });

    expect(transport.sent[0].text).toContain('No conversation yet');
  });

  it('/new discards the conversation so far', async () => {
    const transport = new FakeTransport();
    await started(transport, await makeBridge(transport));

    await transport.deliver({ text: 'first' });
    await transport.deliver({ text: '/status' });
    expect(transport.sent.at(-1)?.text).toContain('Turns:  1');

    await transport.deliver({ text: '/new' });
    await transport.deliver({ text: '/status' });
    expect(transport.sent.at(-1)?.text).toContain('Turns:  0');
  });

  it('keeps separate conversations per chat', async () => {
    const transport = new FakeTransport();
    await started(transport, await makeBridge(transport));

    await transport.deliver({ chatId: 'a', text: 'one' });
    await transport.deliver({ chatId: 'a', text: 'two' });
    await transport.deliver({ chatId: 'b', text: 'first here' });
    await transport.deliver({ chatId: 'b', text: '/status' });

    expect(transport.sent.at(-1)?.text).toContain('Turns:  1');
  });

  it('reuses one gateway session per chat rather than opening one per message', async () => {
    const transport = new FakeTransport();
    await started(transport, await makeBridge(transport));

    await transport.deliver({ chatId: 'a', text: 'one' });
    await transport.deliver({ chatId: 'a', text: 'two' });

    // The harness opened one of its own; the bridge should have added exactly
    // one more, not one per message.
    expect(harness!.sessions.list()).toHaveLength(2);
  });

  it('ignores a blank message rather than sending an empty turn', async () => {
    const transport = new FakeTransport();
    await started(transport, await makeBridge(transport));

    await transport.deliver({ text: '   ' });

    expect(transport.sent).toEqual([]);
  });
});

describe('ChannelBridge tool policy', () => {
  const writeCall = {
    name: 'write_file',
    arguments: JSON.stringify({ path: 'evidence.txt', content: 'written remotely' }),
  };

  it('declines tool calls when no terminal is attached, and says so', async () => {
    const transport = new FakeTransport();
    const bridge = await makeBridge(transport, {
      provider: fakeProvider('done', writeCall),
    });
    // The harness attaches a terminal that *can* approve, so drop it first —
    // this test is about the case where nobody is at a keyboard.
    await harness!.client.close();
    await started(transport, bridge);

    await transport.deliver({ text: 'write a file' });

    expect(transport.sent[0].text).toContain('declined');
  });

  it('does not add the warning when nothing was declined', async () => {
    const transport = new FakeTransport();
    await started(transport, await makeBridge(transport));

    await transport.deliver({ text: 'hi' });

    expect(transport.sent[0].text).not.toContain('declined');
  });

  it('reports auto-approval in /status when --allow-tools is set', async () => {
    const transport = new FakeTransport();
    await started(transport, await makeBridge(transport, { allowTools: true }));

    await transport.deliver({ text: 'first' });
    await transport.deliver({ text: '/status' });

    expect(transport.sent.at(-1)?.text).toContain('auto-approved');
  });

  it('marks the session auto-approve rather than deciding per call', async () => {
    const transport = new FakeTransport();
    await started(transport, await makeBridge(transport, { allowTools: true }));

    await transport.deliver({ text: 'hi' });

    // Visible in /session and in `robin gateway status`, which a per-call flag
    // on a process never was.
    const bridged = harness!.sessions.list().find((s) => s.label?.startsWith('fake'));
    expect(bridged?.autoApprove).toBe(true);
  });
});

describe('ChannelBridge serialisation', () => {
  it('handles two messages in the same chat one at a time', async () => {
    const transport = new FakeTransport();
    await started(transport, await makeBridge(transport));

    // Both dispatched before either is awaited — the queue must still order
    // them, and must not open two sessions for the one chat.
    await Promise.all([
      transport.deliver({ text: 'first' }),
      transport.deliver({ text: 'second' }),
    ]);

    await transport.deliver({ text: '/status' });
    expect(transport.sent.at(-1)?.text).toContain('Turns:  2');
    expect(harness!.sessions.list()).toHaveLength(2);
  });
});
