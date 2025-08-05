/* eslint-disable no-console */
import { ExtensionContext } from 'vscode';

import { addHoverProvider } from './hover-provider';
import { addLanguageConfig } from './lang-config';

// ---
export function activate(context: ExtensionContext) {
  console.log('Activated @env-spec language plugin');
  addLanguageConfig(context);
  addHoverProvider(context);
}

// This method is called when your extension is deactivated
export function deactivate() {
  console.log('@env-spec language plugin now deactivated');
}
