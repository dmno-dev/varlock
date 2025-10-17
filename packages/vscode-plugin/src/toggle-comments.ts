import {
  window, commands, ExtensionContext,
} from 'vscode';

function canUncomment(lineStr: string) {
  // if line is not a comment, we cannot uncoment it
  if (!lineStr.startsWith('#')) return false;
  // remove leading "# " to get the comment contents
  const commentStr = lineStr.replace(/^# ?/, '');
  // double comment `# # @required`
  if (commentStr.startsWith('#')) return true;
  // commented item `# ITEM=...`
  if (commentStr.match(/^[a-zA-Z0-9_-]+=/)) return true;
  // commented blank line `# `
  if (commentStr.trim() === '') return true;
  return false;
}

export function addToggleCommentsCommand2(context: ExtensionContext) {
  const disposable = commands.registerCommand('env-spec.toggleLineComment', () => {
    const editor = window.activeTextEditor;
    if (!editor) return;
    const selection = editor.selection;
    const isMultiLine = selection.start.line !== selection.end.line;

    let action = 'none' as 'none' | 'comment' | 'uncomment';

    // MULTILINE MODE
    if (isMultiLine) {
      // check if all lines can be uncommented, otherwise we comment
      let allCommented = true;
      for (let n = selection.start.line; n <= selection.end.line; n++) {
        const line = editor.document.lineAt(n);
        const lineStr = line.text;
        if (!lineStr.trim()) continue; // if blank we just skip it
        if (canUncomment(lineStr)) continue;
        allCommented = false;
        break;
      }
      action = allCommented ? 'uncomment' : 'comment';

    // SINGLE LINE MODE
    } else {
      const line = editor.document.lineAt(selection.start.line);
      const lineStr = line.text;
      // if not yet a comment, make it one
      if (!lineStr.startsWith('#')) {
        action = 'comment';
      } else {
        action = canUncomment(lineStr) ? 'uncomment' : 'comment';
      }
    }

    editor.edit((editBuilder) => {
      for (let n = selection.start.line; n <= selection.end.line; n++) {
        const l = editor.document.lineAt(n);
        if (action === 'comment') {
          editBuilder.replace(l.range, `# ${l.text}`);
        } else if (action === 'uncomment') {
          editBuilder.replace(l.range, l.text.replace(/^#\s?(.*)/, '$1'));
        }
      }
    });
  });

  context.subscriptions.push(disposable);
}

export function addToggleCommentsCommand(context: ExtensionContext) {
  const disposable = commands.registerCommand('env-spec.toggleLineComment', () => {
    const editor = window.activeTextEditor;
    if (!editor) return;
    const selection = editor.selection;
    const isMultiLine = selection.start.line !== selection.end.line;

    let action = 'none' as 'none' | 'comment' | 'uncomment';

    // MULTILINE MODE
    if (isMultiLine) {
      let everyLineIsCommentOrBlank = true;
      let canUncommentEveryLine = true;
      let commentedDecorator = false;
      let commentedItem = false;
      for (let n = selection.start.line; n <= selection.end.line; n++) {
        const line = editor.document.lineAt(n);
        const lineStr = line.text;
        if (!lineStr.trim()) continue; // ignore blank lines

        if (!lineStr.startsWith('#')) {
          everyLineIsCommentOrBlank = false;
          break;
        }

        const commentStr = lineStr.replace(/^# ?/, '');
        // commented item `# ITEM=...`
        if (commentStr.match(/^[a-zA-Z0-9_-]+=/)) commentedItem = true;
        // commented decorator
        if (commentStr.match(/^@[a-zA-Z0-9_-]+/)) commentedDecorator = true;
        if (!canUncomment(lineStr)) canUncommentEveryLine = false;
      }

      // the awkward case here is that within multiline values
      // we have things that dont look like they can be uncommented on their own
      // so in that case we'll take some additional hints based on the presence of
      // commented items or decorators

      if (everyLineIsCommentOrBlank) {
        // straightforward case, we can uncomment everything safely
        if (canUncommentEveryLine) action = 'uncomment';
        // we cannot uncomment a decorator, so we will comment
        else if (commentedDecorator) action = 'comment';
        // we will take finding a commented item as a sign to uncomment
        else if (commentedItem) action = 'uncomment';
        // otherwise default to comment
        else action = 'comment';
      } else {
        action = 'comment';
      }

    // SINGLE LINE MODE
    // note this will do weird things within multiline values but we dont care
    // because it does not make sense to comment those individual lines anyway
    } else {
      const line = editor.document.lineAt(selection.start.line);
      const lineStr = line.text;
      // if not yet a comment, make it one
      if (!lineStr.startsWith('#')) {
        action = 'comment';
      } else {
        action = canUncomment(lineStr) ? 'uncomment' : 'comment';
      }
    }

    editor.edit((editBuilder) => {
      for (let n = selection.start.line; n <= selection.end.line; n++) {
        const l = editor.document.lineAt(n);
        if (action === 'comment') {
          editBuilder.replace(l.range, `# ${l.text}`);
        } else if (action === 'uncomment') {
          editBuilder.replace(l.range, l.text.replace(/^#\s?(.*)/, '$1'));
        }
      }
    });
  });

  context.subscriptions.push(disposable);
}

