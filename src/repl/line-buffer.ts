/**
 * A multiline text buffer with a cursor. Pure — no terminal, no I/O.
 *
 * The cursor is one offset into `value`; line and column are derived from it.
 * Storing all three lets them drift apart, which is the usual source of
 * off-by-one bugs in editors like this.
 */
export class LineBuffer {
  private value = '';
  private offset = 0;

  get text(): string {
    return this.value;
  }

  get lines(): string[] {
    return this.value.split('\n');
  }

  get cursorLine(): number {
    return this.value.slice(0, this.offset).split('\n').length - 1;
  }

  get cursorColumn(): number {
    const before = this.value.slice(0, this.offset);
    return before.length - (before.lastIndexOf('\n') + 1);
  }

  get atFirstLine(): boolean {
    return this.cursorLine === 0;
  }

  get atLastLine(): boolean {
    return this.cursorLine === this.lines.length - 1;
  }

  get isEmpty(): boolean {
    return this.value.length === 0;
  }

  insert(text: string): void {
    this.value = this.value.slice(0, this.offset) + text + this.value.slice(this.offset);
    this.offset += text.length;
  }

  newline(): void {
    this.insert('\n');
  }

  backspace(): void {
    if (this.offset === 0) return;
    this.value = this.value.slice(0, this.offset - 1) + this.value.slice(this.offset);
    this.offset -= 1;
  }

  moveLeft(): void {
    if (this.offset > 0) this.offset -= 1;
  }

  moveRight(): void {
    if (this.offset < this.value.length) this.offset += 1;
  }

  /** No-op on the first line, so the caller can fall through to input history. */
  moveUp(): void {
    if (this.atFirstLine) return;
    this.moveToLine(this.cursorLine - 1, this.cursorColumn);
  }

  /** No-op on the last line, so the caller can fall through to input history. */
  moveDown(): void {
    if (this.atLastLine) return;
    this.moveToLine(this.cursorLine + 1, this.cursorColumn);
  }

  setText(text: string): void {
    this.value = text;
    this.offset = text.length;
  }

  clear(): void {
    this.setText('');
  }

  /** Column is clamped, so moving onto a shorter line lands at its end. */
  private moveToLine(line: number, column: number): void {
    const lines = this.lines;
    let start = 0;
    for (let i = 0; i < line; i++) start += lines[i].length + 1;
    this.offset = start + Math.min(column, lines[line].length);
  }
}
