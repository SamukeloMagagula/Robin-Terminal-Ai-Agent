import { describe, it, expect, vi, afterEach } from 'vitest';
import { startHarness, type GatewayHarness } from '../helpers/gateway-harness';
import { AcpBridge } from '../../src/acp/bridge';
import { JsonRpcConnection } from '../../src/acp/jsonrpc-connection';
import type { AcpTransport } from '../../src/acp/transport';
import type { Provider } from '../../src/providers/types';

function fakeTransport() {
  let handler: ((msg: Record<string, unknown>) => void) | undefined;
  const sent: Record<string, unknown>[] = [];
  const transport: AcpTransport = {
    onMessage: (h) => {
      handler = h;
    },
    send: (msg) => sent.push(msg),
    onClose: () => {},
    close: () => {},
  };
  return { transport, sent, deliver: (msg: Record<string, unknown>) => handler?.(msg) };
}

function providerYielding(
  ...rounds: (
    | { text: string }
    | { toolCall: { id: string; name: string; arguments: Record<string, unknown> } }
  )[]
): Provider {
  let round = 0;
  return {
    id: 'copilot',
    name: 'GitHub Copilot',
    isAuthenticated: vi.fn().mockResolvedValue(true),
    login: vi.fn(),
    logout: vi.fn(),
    listModels: vi.fn().mockResolvedValue(['gpt-4o']),
    chat: vi.fn().mockImplementation(async function* () {
      const step = rounds[round++];
      if (!step) {
        yield { type: 'text', text: 'done' };
        return;
      }
      if ('text' in step) {
        yield { type: 'text', text: step.text };
      } else {
        // ToolCall.arguments is a JSON-encoded string, not a raw object.
        yield {
          type: 'tool_call',
          toolCall: {
            id: step.toolCall.id,
            name: step.toolCall.name,
            arguments: JSON.stringify(step.toolCall.arguments),
          },
        };
      }
    }),
  } as unknown as Provider;
}

let harness: GatewayHarness | undefined;

afterEach(async () => {
  if (harness) await harness.close();
  harness = undefined;
});

async function setup(providers?: Provider[]) {
  harness = await startHarness({ providers, cwd: '.' });
  const { transport, sent, deliver } = fakeTransport();
  const connection = new JsonRpcConnection(transport);
  const bridge = new AcpBridge(connection, {
    client: harness.client,
    resolveDefault: async () => ({ providerId: harness!.sessions.list()[0]?.providerId ?? 'copilot', model: 'gpt-4o' }),
  });
  return { harness, transport, sent, deliver, bridge };
}

/** Polls until `find` returns something, rather than a fixed sleep — robust under load. */
async function waitForSent(
  sent: Record<string, unknown>[],
  find: (s: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  await vi.waitFor(
    () => {
      found = sent.find(find);
      expect(found).toBeDefined();
    },
    { timeout: 5000, interval: 10 }
  );
  return found!;
}

describe('AcpBridge — initialize', () => {
  it('reports protocolVersion 1, no loadSession, no auth methods, no gateway call', async () => {
    const { sent, deliver } = await setup();
    deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });

    const response = await waitForSent(sent, (s) => s.id === 1);
    expect(sent).toHaveLength(1);
    const result = response.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe(1);
    expect((result.agentCapabilities as Record<string, unknown>).loadSession).toBe(false);
    expect(result.authMethods).toEqual([]);
  });
});

describe('AcpBridge — session/new', () => {
  it('creates a fresh gateway session and returns a new ACP session id each time', async () => {
    const { sent, deliver } = await setup();
    deliver({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: process.cwd() } });
    const first = ((await waitForSent(sent, (s) => s.id === 1)).result as Record<string, unknown>).sessionId;

    deliver({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd() } });
    const second = ((await waitForSent(sent, (s) => s.id === 2)).result as Record<string, unknown>).sessionId;

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });
});

describe('AcpBridge — session/prompt', () => {
  it('sends only text blocks from a mixed prompt', async () => {
    const provider = providerYielding({ text: 'ok' });
    const { sent, deliver } = await setup([provider]);

    deliver({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: process.cwd() } });
    const sessionId = ((await waitForSent(sent, (s) => s.id === 1)).result as Record<string, unknown>).sessionId;

    deliver({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: {
        sessionId,
        prompt: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'xxx', mimeType: 'image/png' },
        ],
      },
    });
    await waitForSent(sent, (s) => s.id === 2);

    expect(provider.chat).toHaveBeenCalled();
    const messages = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(messages.some((m: { content: string }) => m.content.includes('hello'))).toBe(true);
    expect(messages.some((m: { content: string }) => m.content.includes('xxx'))).toBe(false);
  });

  it('resolves with stopReason end_turn on a normal completion', async () => {
    const provider = providerYielding({ text: 'ok' });
    const { sent, deliver } = await setup([provider]);
    deliver({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: process.cwd() } });
    const sessionId = ((await waitForSent(sent, (s) => s.id === 1)).result as Record<string, unknown>).sessionId;

    deliver({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    });
    const response = await waitForSent(sent, (s) => s.id === 2);

    expect((response.result as Record<string, unknown>).stopReason).toBe('end_turn');
  });

  it('streams agent_message_chunk session/update notifications as text arrives', async () => {
    const provider = providerYielding({ text: 'streamed reply' });
    const { sent, deliver } = await setup([provider]);
    deliver({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: process.cwd() } });
    const sessionId = ((await waitForSent(sent, (s) => s.id === 1)).result as Record<string, unknown>).sessionId;

    deliver({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    });
    await waitForSent(sent, (s) => s.id === 2);

    const chunk = await waitForSent(
      sent,
      (s) =>
        s.method === 'session/update' &&
        ((s.params as Record<string, unknown>).update as Record<string, unknown>).sessionUpdate ===
          'agent_message_chunk'
    );
    expect(chunk).toBeDefined();
  });

  it('returns a JSON-RPC error for an unknown sessionId rather than throwing', async () => {
    const { sent, deliver } = await setup();
    deliver({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 'nope', prompt: [{ type: 'text', text: 'hi' }] },
    });

    const response = await waitForSent(sent, (s) => s.id === 1);
    expect(sent).toHaveLength(1);
    expect(response.error).toBeDefined();
  });
});

describe('AcpBridge — permission requests', () => {
  it('sends session/request_permission for a confirm-gated tool call, and answers approval on approved', async () => {
    const provider = providerYielding({
      // Not on the read-only allowlist, so it forces a confirm() call — but
      // fast and side-effect-free, unlike a real install.
      toolCall: { id: 't1', name: 'run_command', arguments: { command: 'node -e "1"' } },
    });
    const { sent, deliver } = await setup([provider]);
    deliver({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: process.cwd() } });
    const sessionId = ((await waitForSent(sent, (s) => s.id === 1)).result as Record<string, unknown>).sessionId;

    deliver({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'install lodash' }] },
    });

    const permissionReq = await waitForSent(sent, (s) => s.method === 'session/request_permission');
    const reqId = permissionReq.id as string | number;

    deliver({ jsonrpc: '2.0', id: reqId, result: { outcome: { outcome: 'selected', optionId: 'yes' } } });

    const response = await waitForSent(sent, (s) => s.id === 2);
    expect((response.result as Record<string, unknown>).stopReason).toBe('end_turn');
  });
});

describe('AcpBridge — permission request timeout', () => {
  it('treats an unanswered permission request as declined after the timeout, rather than hanging forever', async () => {
    const provider = providerYielding({
      toolCall: { id: 't1', name: 'run_command', arguments: { command: 'node -e "1"' } },
    });
    harness = await startHarness({ providers: [provider], cwd: '.' });
    const { transport, sent, deliver } = fakeTransport();
    const connection = new JsonRpcConnection(transport);
    new AcpBridge(connection, {
      client: harness.client,
      resolveDefault: async () => ({ providerId: 'copilot', model: 'gpt-4o' }),
      permissionTimeoutMs: 20,
    });

    deliver({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: process.cwd() } });
    const sessionId = ((await waitForSent(sent, (s) => s.id === 1)).result as Record<string, unknown>).sessionId;

    deliver({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'install' }] },
    });

    await waitForSent(sent, (s) => s.method === 'session/request_permission');
    // Never answered — the timeout is what has to resolve this.

    const response = await waitForSent(sent, (s) => s.id === 2);
    expect((response.result as Record<string, unknown>).stopReason).toBe('end_turn');
  });
});

describe('AcpBridge — gateway disconnect', () => {
  it('resolves a pending session/prompt with stopReason cancelled rather than hanging forever', async () => {
    // A provider whose chat() never resolves — the turn is genuinely stuck,
    // proving the resolution comes from the disconnect handling, not the turn
    // completing on its own by coincidence.
    const provider: Provider = {
      id: 'copilot',
      name: 'GitHub Copilot',
      isAuthenticated: vi.fn().mockResolvedValue(true),
      login: vi.fn(),
      logout: vi.fn(),
      listModels: vi.fn().mockResolvedValue(['gpt-4o']),
      chat: vi.fn().mockImplementation(() => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      })),
    } as unknown as Provider;

    const { harness: h, sent, deliver } = await setup([provider]);
    deliver({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: process.cwd() } });
    const sessionId = ((await waitForSent(sent, (s) => s.id === 1)).result as Record<string, unknown>).sessionId;

    deliver({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    });
    // Wait until the turn is genuinely in flight (the provider has been
    // asked) before disconnecting, so the resolution can only come from the
    // disconnect handling — the turn itself never finishes on its own.
    await vi.waitFor(() => expect(provider.chat).toHaveBeenCalled(), { timeout: 5000, interval: 10 });

    await h.close();
    harness = undefined; // already closed; afterEach must not close it again

    const response = await waitForSent(sent, (s) => s.id === 2);
    expect((response.result as Record<string, unknown>).stopReason).toBe('cancelled');
  });
});

describe('AcpBridge — session/cancel', () => {
  it('interrupts the current turn for that session', async () => {
    const provider = providerYielding({ text: 'ok' });
    const { harness: h, sent, deliver } = await setup([provider]);
    deliver({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: process.cwd() } });
    const sessionId = ((await waitForSent(sent, (s) => s.id === 1)).result as Record<string, unknown>).sessionId;

    const interruptSpy = vi.spyOn(h.sessions, 'interrupt');

    deliver({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    });
    // Cancelling before prompt.send has registered the current turn id would
    // be a no-op by construction, not proof interrupt works — so wait for
    // *some* sign the turn is underway (a session/update) before cancelling.
    // If the turn already finished by then, the map entry still holds the
    // last turn id, so interrupt() is still exercised either way.
    await Promise.race([waitForSent(sent, (s) => s.method === 'session/update'), waitForSent(sent, (s) => s.id === 2)]);
    deliver({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });

    await vi.waitFor(() => expect(interruptSpy).toHaveBeenCalled(), { timeout: 5000, interval: 10 });
  });
});
