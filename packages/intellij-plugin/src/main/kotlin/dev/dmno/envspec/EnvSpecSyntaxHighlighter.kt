package dev.dmno.envspec

import com.intellij.lexer.Lexer
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors as Default
import com.intellij.openapi.fileTypes.SyntaxHighlighterBase
import com.intellij.psi.TokenType
import com.intellij.psi.tree.IElementType

class EnvSpecSyntaxHighlighter : SyntaxHighlighterBase() {

    override fun getHighlightingLexer(): Lexer = EnvSpecLexer()

    override fun getTokenHighlights(tokenType: IElementType): Array<TextAttributesKey> {
        return when (tokenType) {
            TokenType.WHITE_SPACE -> EMPTY_KEYS
            EnvSpecTokenTypes.NEWLINE -> EMPTY_KEYS
            EnvSpecTokenTypes.LINE_COMMENT -> LINE_COMMENT_KEYS
            EnvSpecTokenTypes.DECORATOR -> DECORATOR_KEYS
            EnvSpecTokenTypes.DECORATOR_VALUE -> DECORATOR_VALUE_KEYS
            EnvSpecTokenTypes.DECORATOR_ARGS -> DECORATOR_ARGS_KEYS
            EnvSpecTokenTypes.DECORATOR_ARG_KEY -> DECORATOR_ARG_KEY_KEYS
            EnvSpecTokenTypes.DECORATOR_ARG_VALUE -> DECORATOR_ARG_VALUE_KEYS
            EnvSpecTokenTypes.EXPORT_KEYWORD -> KEYWORD_KEYS
            EnvSpecTokenTypes.ENV_KEY -> INSTANCE_FIELD_KEYS
            EnvSpecTokenTypes.EQUALS -> OPERATION_SIGN_KEYS
            EnvSpecTokenTypes.PAREN_OPEN -> OPERATION_SIGN_KEYS
            EnvSpecTokenTypes.PAREN_CLOSE -> OPERATION_SIGN_KEYS
            EnvSpecTokenTypes.ENV_VALUE -> STRING_KEYS
            EnvSpecTokenTypes.VALUE_FUNCTION -> FUNCTION_CALL_KEYS
            EnvSpecTokenTypes.VALUE_REFERENCE -> VALUE_REFERENCE_KEYS
            EnvSpecTokenTypes.LINE_CONTENT -> DEFAULT_KEYS
            TokenType.BAD_CHARACTER -> BAD_CHARACTER_KEYS
            else -> EMPTY_KEYS
        }
    }

    companion object {
        val LINE_COMMENT: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "ENV_SPEC.LINE_COMMENT",
            Default.LINE_COMMENT,
        )
        val EXPORT_KEYWORD: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "ENV_SPEC.EXPORT",
            Default.KEYWORD,
        )
        val DECORATOR: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "ENV_SPEC.DECORATOR",
            Default.METADATA,
        )
        val DECORATOR_VALUE: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "ENV_SPEC.DECORATOR_VALUE",
            Default.STRING,
        )
        val DECORATOR_ARGS: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "ENV_SPEC.DECORATOR_ARGS",
            Default.IDENTIFIER,
        )
        val DECORATOR_ARG_KEY: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "ENV_SPEC.DECORATOR_ARG_KEY",
            Default.PARAMETER,
        )
        val DECORATOR_ARG_VALUE: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "ENV_SPEC.DECORATOR_ARG_VALUE",
            Default.STRING,
        )
        val ENV_KEY: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "ENV_SPEC.KEY",
            Default.INSTANCE_FIELD,
        )
        val EQUALS: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "ENV_SPEC.EQUALS",
            Default.OPERATION_SIGN,
        )
        val ENV_VALUE: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "ENV_SPEC.VALUE",
            Default.STRING,
        )
        val VALUE_FUNCTION: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "ENV_SPEC.VALUE_FUNCTION",
            Default.FUNCTION_CALL,
        )
        val VALUE_REFERENCE: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "ENV_SPEC.VALUE_REFERENCE",
            Default.GLOBAL_VARIABLE,
        )
        val DEFAULT: TextAttributesKey = TextAttributesKey.createTextAttributesKey(
            "ENV_SPEC.DEFAULT",
            Default.IDENTIFIER,
        )

        private val LINE_COMMENT_KEYS = arrayOf(LINE_COMMENT)
        private val DECORATOR_KEYS = arrayOf(DECORATOR)
        private val DECORATOR_VALUE_KEYS = arrayOf(DECORATOR_VALUE)
        private val DECORATOR_ARGS_KEYS = arrayOf(DECORATOR_ARGS)
        private val DECORATOR_ARG_KEY_KEYS = arrayOf(DECORATOR_ARG_KEY)
        private val DECORATOR_ARG_VALUE_KEYS = arrayOf(DECORATOR_ARG_VALUE)
        private val KEYWORD_KEYS = arrayOf(EXPORT_KEYWORD)
        private val INSTANCE_FIELD_KEYS = arrayOf(ENV_KEY)
        private val OPERATION_SIGN_KEYS = arrayOf(EQUALS)
        private val STRING_KEYS = arrayOf(ENV_VALUE)
        private val FUNCTION_CALL_KEYS = arrayOf(VALUE_FUNCTION)
        private val VALUE_REFERENCE_KEYS = arrayOf(VALUE_REFERENCE)
        private val DEFAULT_KEYS = arrayOf(DEFAULT)
        private val BAD_CHARACTER_KEYS = arrayOf(Default.INVALID_STRING_ESCAPE)
        private val EMPTY_KEYS = emptyArray<TextAttributesKey>()
    }
}
