import type { NextApiRequest, NextApiResponse } from 'next';

import { ENV } from 'varlock/env';

// Deliberately leak a sensitive value from a pages-router API route. `res.json()`
// writes the whole body through a single `ServerResponse.end()` call, so the leak is
// caught there rather than in `write()`. Varlock has to finish the response itself
// (the client would otherwise hang), and next's `apiResolver` catch path then calls
// `res.end()` a second time - which must not take the dev server down.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ leaked: ENV.SENSITIVE_VAR });
}
