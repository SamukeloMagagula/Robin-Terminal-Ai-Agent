/**
 * Serializes approval prompts to one at a time.
 *
 * The gateway's ApprovalRegistry already holds an arbitrary number of
 * concurrent pending approvals per session — concurrency was never its
 * problem. But the REPL renders each one as an `@inquirer/prompts` dialog,
 * and two of those live at once in the same terminal fight over the same
 * stdin/stdout. Concurrent subagents (delegate_task) are exactly what makes
 * two approval requests arrive close together, so this exists to keep the
 * terminal showing one question at a time regardless of how many are pending.
 */
export class ApprovalQueue {
  private tail: Promise<void> = Promise.resolve();
  /** Ids resolved by another client before their turn in the queue arrived. */
  private readonly settled = new Set<string>();
  /** Ids still waiting their turn — settleElsewhere only needs to touch these. */
  private readonly queued = new Set<string>();

  enqueue(id: string, render: () => Promise<void>): void {
    this.queued.add(id);
    this.tail = this.tail.then(async () => {
      this.queued.delete(id);
      if (this.settled.has(id)) {
        this.settled.delete(id);
        return;
      }
      try {
        await render();
      } catch {
        // One prompt failing must not stop the rest of the queue.
      }
    });
  }

  /** Marks a still-queued id as already settled, so its turn is skipped rather than rendered. */
  settleElsewhere(id: string): void {
    if (this.queued.has(id)) this.settled.add(id);
  }
}
