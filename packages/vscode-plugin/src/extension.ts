/*
  NOTE - we're not doing anything here yet, but this is the shell that will let us start doing more than just highlighting


*/
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('Activated env-spec language plugin');
}

// This method is called when your extension is deactivated
export function deactivate() {
  console.log('env-spec language plugin now deactivated');
}
