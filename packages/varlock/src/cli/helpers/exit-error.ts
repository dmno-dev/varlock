import ansis from 'ansis';
import _ from '@env-spec/utils/my-dash';
import { joinAndCompact } from '../../lib/formatting';

export class CliExitError extends Error {
  constructor(
    message: string,
    private more?: {
      details?: string | Array<string>,
      suggestion?: string | Array<string>,
      /** always triggers a full exit, even in watch mode - useful if problem is irrecoverable */
      forceExit?: boolean,
      /** suppress formatted output (details already logged to stderr) */
      silent?: boolean,
    },
  ) {
    super(message);
  }

  get forceExit() { return !!this.more?.forceExit; }

  getFormattedOutput() {
    if (this.more?.silent) return '';

    let msg = `\n💥 ${ansis.red(this.message)} 💥\n`;

    if (this.more?.details) {
      msg += joinAndCompact(_.castArray(this.more?.details), '\n');
      // separate the details block from the suggestion (otherwise they render glued
      // together, e.g. "…recover real values.Re-approve the change…")
      msg += '\n';
    }

    if (this.more?.suggestion) {
      msg += joinAndCompact(_.castArray(this.more?.suggestion), '\n');
    }

    msg += '\n';
    return msg;
  }
}
