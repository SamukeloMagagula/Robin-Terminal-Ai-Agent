import type { ReplContext } from '../repl-context.js';
import { wrapUntrusted } from '../../tools/execute.js';
import { searchChatLogs } from '../../recall.js';
import { renderUsageReport } from '../../usage/render-usage.js';
import { assistantColor, errorColor, mutedColor } from '../../ui/theme.js';

export const HELP_ENTRIES: [string, string][] = [
  ['/help', 'list commands'],
  ['/model', 'switch model on the current provider'],
  ['/provider', 'switch provider (e.g. Copilot ↔ Ollama) — pick "← Back" in the model list to change your mind'],
  ['/system [text]', 'view, set, or "/system clear" the system prompt'],
  ['/tools [list]', 'toggle tool-calling on/off, or list available tools'],
  ['/save [name]', 'save the conversation, or list saved ones'],
  ['/load [name]', 'load a saved conversation, or list saved ones'],
  ['/copy', "copy the assistant's last reply to the clipboard"],
  ['/skill save <name>', 'save the current system prompt as a reusable named skill'],
  ['/skill use <name>', 'apply a saved skill as the system prompt'],
  ['/skill [list]', 'list saved skills'],
  ['/skill migrate', 'convert old JSON presets to markdown skills'],
  ['/personality [reload|off]', 'show the active PERSONALITY.md, reload it, or drop it'],
  ['/memory [show|forget]', 'list what Robin has remembered, read one, or remove one'],
  ['/session [new|<n>|close]', 'run several conversations at once and switch between them'],
  ['/workflow run <goal>', 'plan, build, test and validate with a model per role'],
  ['/random', 'switch to a randomly chosen provider and model'],
  ['/usage', 'OpenRouter spend for this key, and the account balance'],
  ['/recall <query>', 'search past conversations under ~/.robin/chats/'],
  ['/history', 'show where input history is stored, or "/history clear" to wipe it'],
  ['/clear', 'reset the conversation'],
  ['/exit', 'quit'],
];

export async function handleHelp(): Promise<void> {
  for (const [name, description] of HELP_ENTRIES) {
    console.log(`  ${assistantColor(name.padEnd(20))}${mutedColor(description)}`);
  }
}

export async function handleUsage(ctx: ReplContext): Promise<void> {
  const usage = await ctx.stores.usage.get();
  console.log(
    usage
      ? renderUsageReport(usage)
      : mutedColor(
          'No OpenRouter usage available — run `robin login openrouter`, or check your connection.'
        )
  );
}

export async function handleRecall(ctx: ReplContext, arg?: string): Promise<void> {
  if (!arg) {
    console.log(errorColor('✖ Usage: /recall <query>'));
    return;
  }
  const { matches, source } = await ctx.stores.recall.search(arg);
  if (matches.length === 0) {
    console.log(mutedColor(`No matches for "${arg}" in ~/.robin/chats/.`));
    return;
  }
  if (source === 'grep') {
    // Visible rather than silent: results are the same, the search is linear.
    console.log(mutedColor('(searching without the index — SQLite is unavailable)'));
  }

  for (const match of matches) {
    console.log(`  ${assistantColor(match.file)}${mutedColor(`:${match.lineNumber}`)}`);
    for (const line of match.context) {
      console.log(`    ${mutedColor(line)}`);
    }
    console.log();
  }
  // Add to the conversation (not just the terminal) so a follow-up like
  // "yep that one" has something for the model to actually refer to.
  const recalled = matches
    .map((m) => `[${m.file}:${m.lineNumber}]\n${m.context.join('\n')}`)
    .join('\n\n');
  // Transcripts contain past tool output — file contents and command output
  // that were wrapped as untrusted the first time round. Replaying them as a
  // plain user message would launder that text back into the context as if the
  // user had typed it, so re-wrap it.
  ctx.session.history.push({
    role: 'user',
    content: wrapUntrusted(`recalled excerpts from past conversations matching "${arg}"`, recalled),
  });
  console.log(mutedColor('(Added to the conversation — you can refer to it in your next message.)'));
}
