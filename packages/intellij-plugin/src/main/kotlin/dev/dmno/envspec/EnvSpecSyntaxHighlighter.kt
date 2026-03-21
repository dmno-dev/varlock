package dev.dmno.envspec

import com.intellij.lexer.Lexer
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.fileTypes.SyntaxHighlighterBase
import com.intellij.psi.tree.IElementType
import com.intellij.psi.TokenType
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors as Default

class EnvSpecSyntaxHighlighter : SyntaxHighlighterBase() {

    override fun getHighlightingLexer(): Lexer = EnvSpecLexer()

    override fun getTokenHighlights(tokenType: IElementType): Array<TextAttributesKey> {
        return when (tokenType) {
            EnvSpecTokenTypes.LINE_CONTENT -> LINE_KEYS
            EnvSpecTokenTypes.NEWLINE -> EMPTY_KEYS
            TokenType.BAD_CHARACTER -> BAD_CHARACTER_KEYS
            else -> EMPTY_KEYS
        }
    }

    companion object {
        private val LINE_KEYS = arrayOf(Default.TEMPLATE_LANGUAGE_COLOR)
        private val BAD_CHARACTER_KEYS = arrayOf(Default.INVALID_STRING_ESCAPE)
        private val EMPTY_KEYS = emptyArray<TextAttributesKey>()
    }
}
