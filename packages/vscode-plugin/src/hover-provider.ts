/*
  Super basic "hover provider" functionality to give some hover help

  for now we'll just give info about known decorators
*/
import { ExtensionContext, Hover, languages } from 'vscode';
import { LANG_ID } from './constants';
import outdent from 'outdent';

const KNOWN_DECORATORS: Record<string, any> = {
  required: {
    hoverContent: outdent`
      Sets whether item must be set to pass validation - can be set to true or false.
      Overrides default behaviour set by \`@defaultRequired\` root decorator.
      Opposite decorator \`@optional\` is also available.
    `,
  },
  optional: {
    hoverContent: outdent`
      Sets whether an item is required, as the opposite of \`@required\`.
      Overrides default behaviour set by \`@defaultRequired\` root decorator.
    `,
  },
  sensitive: {
    hoverContent: outdent`
      Sets whether an item should be treated as a sensitive secret
      Overrides default behaviour set by \`@defaultSensitive\` root decorator.
    `,
  },
  type: {
    hoverContent: outdent`
      Sets the data type of this item. Some data types take additional arguments.

      \`@type=boolean\`
      \`@type=number(min=1, max=100)\`

      See https://varlock.dev for list of built-in types
    `,
  },
  example: {
    hoverContent: outdent`
      Sets an example value
    `,
  },
};

export function addHoverProvider(context: ExtensionContext) {
  languages.registerHoverProvider(LANG_ID, {
    provideHover(document, position, token) {
      const hoveredLine = document.lineAt(position.line);
      const lineStr = hoveredLine.text;

      // we are in a comment
      if (lineStr.trim().startsWith('#')) {
        const wordAtPos = document.getWordRangeAtPosition(position, /@?[a-z0-9]+/i);
        const hoveredText = document.getText(wordAtPos);

        if (hoveredText.startsWith('@')) {
          const decName = hoveredText.substring(1);
          const dec = KNOWN_DECORATORS[decName];
          if (dec) {
            return new Hover(dec.hoverContent);
          }
        }
      }
    },
  });
}
