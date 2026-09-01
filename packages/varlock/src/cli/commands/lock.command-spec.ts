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
    'forget-preferences': {
      type: 'boolean',
      description: 'Also forget the unlock choices remembered for this project',
    },
    'forget-all-preferences': {
      type: 'boolean',
      description: 'Forget the unlock choices remembered for every project on this Mac',
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

The unlock panel remembers it when you tighten an approval, so it does not spring back
to the broad default next time. Choosing the broad option again forgets that, and so
does this:

  varlock lock --forget-preferences       # Forget this project's remembered choices
  varlock lock --forget-all-preferences   # Forget every project's
`.trim(),
});
