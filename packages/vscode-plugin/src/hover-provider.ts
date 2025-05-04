/*
  Super basic "hover provider" functionality to give some hover help

  for now we'll just give info about known decorators
*/
import { ExtensionContext, Hover, languages } from 'vscode';
import { LANG_ID } from './constants';
import { deindent } from './utils/deindent';

// NOTE - the content supports markdown, and will be deindented
const ITEM_DECORATORS: Record<string, any> = {
  required: {
    hoverContent: `
      Sets whether item must be set to pass validation - can be set to true or false.
      Overrides default behaviour set by \`@defaultRequired\` root decorator.
      Opposite decorator \`@optional\` is also available.
    `,
  },
  optional: {
    hoverContent: `
      Sets whether an item is required, as the opposite of \`@required\`.
      Overrides default behaviour set by \`@defaultRequired\` root decorator.
    `,
  },
  sensitive: {
    hoverContent: `
      Sets whether an item should be treated as a sensitive secret
      Overrides default behaviour set by \`@defaultSensitive\` root decorator.
    `,
  },
  type: {
    hoverContent: `
      Sets the data type of this item. Some data types take additional arguments.

      \`@type=boolean\`
      \`@type=number(min=1, max=100)\`

      See https://varlock.dev for list of built-in types
    `,
  },
  example: {
    hoverContent: `
      Sets an example value
    `,
  },
};
const ROOT_DECORATORS: Record<string, any> = {
  envFlag: {
    hoverContent: `
      Sets the name of the env var to use for the "environment flag" - which will be used to toggle automatic loading of environment-specific env files (e.g., \`.env.test\`).
      
      For example, setting \`# @envFlag=APP_ENV\` and booting up your application with \`APP_ENV=test\` would cause your \`.env.test\` file to be loaded.
    `,
  },
  defaultRequired: {
    hoverContent: `
      Sets the default behavior for whether items should be considered "required" or not - required items that are emtpy will fail validation.

      Overridden by \`@required\` and \`@optional\` decorators on individual items.
    `,
  },
  defaultSensitive: {
    hoverContent: `
      Sets the default behavior for whether items should be considered "sensitive" (secret) or not - which will trigger special handling to prevent leaking these values.

      Overridden by \`@sensitive\` decorator on individual items.
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
          const dec = ITEM_DECORATORS[decName] || ROOT_DECORATORS[decName];
          if (dec) {
            return new Hover(deindent(dec.hoverContent));
          }
        }
      }
    },
  });
}
