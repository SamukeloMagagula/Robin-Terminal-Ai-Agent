import { gradientText, mutedColor } from './theme.js';

export function printBanner(): void {
  const lines = [
    '',
    `   ${gradientText('╭───────╮')}`,
    `   ${gradientText('│  >_   │')}   ${gradientText('a i - t e r m - c h a t')}`,
    `   ${gradientText('╰───────╯')}   ${mutedColor('chat with AI, right from your terminal')}`,
    '',
  ];
  console.log(lines.join('\n'));
}

const SUBTITLE_WIDTH = 44;

export function printConnectionLine(providerName: string, model: string): void {
  const label = `${providerName} · ${model}`;
  const fillLength = Math.max(SUBTITLE_WIDTH - label.length - 4, 0);
  console.log(`   ${mutedColor('──')} ${label} ${mutedColor('─'.repeat(fillLength))}`);
}
