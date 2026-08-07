// A generic two-column bordered panel. Knows about borders, columns, padding
// and truncation; knows nothing about what gets rendered inside it.

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const ANSI_AT_START = /^\x1b\[[0-9;]*m/;
const RESET = '\x1b[0m';

export interface PanelOptions {
  title: string;
  left: string[];
  right: string[];
  width: number;
  leftWidth: number;
  borderColor: (s: string) => string;
}

/** Length of a string as the terminal draws it, ignoring color escapes. */
export function visibleLength(text: string): number {
  return text.replace(ANSI_PATTERN, '').length;
}

// Keeps color escapes while counting only printable characters, so a colored
// cell truncates at the same place an uncolored one would.
function truncateVisible(text: string, max: number): string {
  let out = '';
  let visible = 0;
  let index = 0;
  while (index < text.length) {
    const escape = ANSI_AT_START.exec(text.slice(index));
    if (escape) {
      out += escape[0];
      index += escape[0].length;
      continue;
    }
    if (visible >= max) break;
    out += text[index];
    visible += 1;
    index += 1;
  }
  return out;
}

function fitCell(text: string, width: number): string {
  const length = visibleLength(text);
  if (length <= width) return text + ' '.repeat(width - length);
  const truncated = truncateVisible(text, Math.max(width - 1, 0));
  const suffix = truncated.includes('\x1b[') ? RESET : '';
  return `${truncated}${suffix}…`;
}

export function renderPanel(options: PanelOptions): string[] {
  const { title, left, right, width, leftWidth, borderColor } = options;
  const innerWidth = width - 4;
  const rightWidth = Math.max(innerWidth - leftWidth, 0);

  const titleLength = visibleLength(title);
  // The title sits in the top border with a single ─ trailing it; below this
  // threshold there is no room left for the border itself, so drop the title.
  const top =
    titleLength > 0 && titleLength <= width - 6
      ? `╭${'─'.repeat(width - 5 - titleLength)} ${title} ─╮`
      : `╭${'─'.repeat(width - 2)}╮`;
  const bottom = `╰${'─'.repeat(width - 2)}╯`;

  const rowCount = Math.max(left.length, right.length);
  const rows: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const leftCell = fitCell(left[i] ?? '', leftWidth);
    const rightCell = fitCell(right[i] ?? '', rightWidth);
    rows.push(`${borderColor('│')} ${leftCell}${rightCell} ${borderColor('│')}`);
  }

  return [borderColor(top), ...rows, borderColor(bottom)];
}
