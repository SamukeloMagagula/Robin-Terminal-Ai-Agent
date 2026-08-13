import chalk from 'chalk';
import type { ReplContext } from '../repl-context.js';
import type { AttachResult, SessionSnapshot } from '../../gateway/protocol.js';
import { printConnectionLine } from '../../ui/banner.js';
import { assistantColor, errorColor, mutedColor } from '../../ui/theme.js';

function describe(session: SessionSnapshot): string {
  return session.label ?? `${session.providerName} · ${session.model}`;
}

/** Attaches this terminal to another session and points the context at it. */
async function switchTo(ctx: ReplContext, id: number): Promise<void> {
  const attached = await ctx.client.request<AttachResult>('session.attach', { id });
  await ctx.client.request('session.detach', { id: ctx.sessionId }).catch(() => {});
  ctx.sessionId = id;
  ctx.snapshot = attached.snapshot;
  console.log(chalk.gray(`Session ${id}.`));
  printConnectionLine(attached.snapshot.providerName, attached.snapshot.model);
  if (attached.history.length > 0) {
    console.log(mutedColor(`${attached.history.length} message(s) already in this conversation.`));
  }
}

export async function handleSession(ctx: ReplContext, arg?: string): Promise<void> {
  const [sub, ...rest] = (arg ?? '').split(' ').filter(Boolean);

  if (!sub || sub === 'list') {
    const { sessions } = await ctx.client.request<{ sessions: SessionSnapshot[] }>(
      'session.list'
    );
    for (const session of sessions) {
      const marker = session.id === ctx.sessionId ? assistantColor('▸') : ' ';
      // Sessions opened by another surface show up here too — that is the
      // point of a shared gateway, and hiding them would make /session a lie.
      const notes = [
        session.busy ? 'busy' : undefined,
        session.queued > 0 ? `${session.queued} queued` : undefined,
        session.autoApprove ? 'auto-approves tools' : undefined,
        session.cwd,
      ].filter(Boolean);
      console.log(
        `${marker} ${assistantColor(String(session.id))}  ${describe(session).padEnd(34)}` +
          mutedColor(notes.join(' · '))
      );
    }
    console.log(mutedColor('\nSwitch with /session <n>, open one with /session new.'));
    return;
  }

  if (sub === 'new') {
    try {
      const picked = await ctx.deps.pickProviderAndModel();
      const created = await ctx.client.request<SessionSnapshot>('session.create', {
        providerId: picked.provider.id,
        model: picked.model,
        cwd: process.cwd(),
      });
      console.log(chalk.gray(`Opened session ${created.id}.`));
      await switchTo(ctx, created.id);
    } catch (err) {
      console.log(errorColor(`✖ ${(err as Error).message}`));
    }
    return;
  }

  if (sub === 'name') {
    const label = rest.join(' ');
    if (!label) {
      console.log(errorColor('✖ Usage: /session name <label>'));
      return;
    }
    ctx.snapshot = await ctx.client.request<SessionSnapshot>('session.update', {
      id: ctx.sessionId,
      patch: { label },
    });
    console.log(chalk.gray(`Session ${ctx.sessionId} is now "${label}".`));
    return;
  }

  if (sub === 'close') {
    // Defaults to the attached session, which is what "close this" means.
    const id = rest[0] ? Number(rest[0]) : ctx.sessionId;
    if (!Number.isInteger(id)) {
      console.log(errorColor('✖ Usage: /session close [n]'));
      return;
    }
    try {
      await ctx.client.request('session.close', { id });
      console.log(chalk.gray(`Closed session ${id}.`));
      if (id !== ctx.sessionId) return;

      // Closing the one you are in has to land somewhere. The gateway may now
      // hold none at all, in which case this terminal opens a fresh one rather
      // than sitting attached to nothing.
      const { sessions } = await ctx.client.request<{ sessions: SessionSnapshot[] }>(
        'session.list'
      );
      const next =
        sessions[0] ??
        (await ctx.client.request<SessionSnapshot>('session.create', {
          providerId: ctx.deps.provider.id,
          model: ctx.deps.model,
          cwd: process.cwd(),
        }));
      ctx.sessionId = next.id;
      ctx.snapshot = await ctx.client
        .request<AttachResult>('session.attach', { id: next.id })
        .then((attached) => attached.snapshot);
      printConnectionLine(ctx.snapshot.providerName, ctx.snapshot.model);
    } catch (err) {
      console.log(errorColor(`✖ ${(err as Error).message}`));
    }
    return;
  }

  const id = Number(sub);
  if (Number.isInteger(id)) {
    try {
      await switchTo(ctx, id);
    } catch (err) {
      console.log(errorColor(`✖ ${(err as Error).message}`));
    }
    return;
  }

  console.log(
    errorColor(`✖ Unknown /session subcommand "${sub}". Usage: /session [list|new|name|close|<n>]`)
  );
}
