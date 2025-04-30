/*
  This automatically inserts a new "# " when hitting enter within a comment
  which makes the editing experience much nicer
*/

import { ExtensionContext, IndentAction, languages } from 'vscode';
import { LANG_ID } from './constants';

export function addLanguageConfig(context: ExtensionContext) {
  const disposable = languages.setLanguageConfiguration(LANG_ID, {
    onEnterRules: [
      {
        // Do not continue comment after a divider
        // ex: `# --- divider ---`
        beforeText: /^\s*#\s*[-=*#]{3,}.*$/,
        action: { indentAction: IndentAction.None, removeText: 1 },
      },
      {
        // Parent doc full-line comment
        // ex: `# some comment ...`
        beforeText: /^\s*#.*$/,
        action: { indentAction: IndentAction.None, appendText: '# ' },
      },
    ],
  });
  context.subscriptions.push(disposable);
}
