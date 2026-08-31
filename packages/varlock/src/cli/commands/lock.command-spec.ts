import { define } from 'gunshi';

export const commandSpec = define({
  name: 'lock',
  description: 'Lock unlock sessions, requiring approval again for the next decrypt',
  args: {
    session: {
      type: 'string',
      description: 'Lock one session by id (see `varlock sessions`)',
    },
    current: {
      type: 'boolean',
      description: "Lock only this terminal's own session",
    },
  },
  examples: `
With no options this locks every session on the machine, which is what you want when
stepping away. The narrower forms end one session and leave the others alone.

--current does not take an id: the daemon works out which session is calling from the
connection itself, so there is no way to name your way into someone else's.

Examples:
  varlock lock                    # Lock every session
  varlock lock --current          # Lock only this terminal's session
  varlock lock --session <id>     # Lock one session by id
  varlock sessions                # See what is currently unlocked
`.trim(),
});
