package dev.dmno.envspec

import com.intellij.codeInsight.editorActions.enter.EnterHandlerDelegate
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.actionSystem.EditorActionHandler
import com.intellij.openapi.util.Ref
import com.intellij.psi.PsiFile

/**
 * After Enter on a line that starts (after whitespace) with `#`, inserts a new line and `# `
 * with the same leading indentation — same idea as VS Code onEnterRules for line comments.
 */
class EnvSpecCommentEnterHandler : EnterHandlerDelegate {

    override fun preprocessEnter(
        file: PsiFile,
        editor: Editor,
        caretOffsetRef: Ref<Int>,
        caretAdvance: Ref<Int>,
        dataContext: DataContext,
        originalHandler: EditorActionHandler?,
    ): EnterHandlerDelegate.Result {
        if (file.language != EnvSpecLanguage) return EnterHandlerDelegate.Result.Continue

        val document = editor.document
        val caretOffset = caretOffsetRef.get()
        val line = document.getLineNumber(caretOffset)
        val lineStart = document.getLineStartOffset(line)
        val lineEnd = document.getLineEndOffset(line)
        val lineText = document.charsSequence.subSequence(lineStart, lineEnd).toString()

        val m = COMMENT_LINE_PREFIX.matchEntire(lineText) ?: return EnterHandlerDelegate.Result.Continue
        val indent = m.groupValues[1]
        val hashOffset = lineStart + indent.length
        if (caretOffset < hashOffset) return EnterHandlerDelegate.Result.Continue

        val project = file.project
        val insert = "\n$indent# "
        WriteCommandAction.runWriteCommandAction(project) {
            document.insertString(caretOffset, insert)
            val newOffset = caretOffset + insert.length
            caretOffsetRef.set(newOffset)
            caretAdvance.set(0)
            editor.caretModel.moveToOffset(newOffset)
        }
        return EnterHandlerDelegate.Result.Stop
    }

    override fun postProcessEnter(
        file: PsiFile,
        editor: Editor,
        dataContext: DataContext,
    ): EnterHandlerDelegate.Result = EnterHandlerDelegate.Result.Continue

    companion object {
        private val COMMENT_LINE_PREFIX = Regex("""^([ \t]*)(#.*)$""")
    }
}
