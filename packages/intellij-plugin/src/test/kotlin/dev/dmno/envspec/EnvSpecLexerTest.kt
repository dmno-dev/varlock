package dev.dmno.envspec

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class EnvSpecLexerTest {

    private data class LexedToken(val type: String, val text: String)

    private fun lex(input: String): List<LexedToken> {
        return lexFromOffset(input, 0)
    }

    private fun lexFromOffset(input: String, startOffset: Int): List<LexedToken> {
        val lexer = EnvSpecLexer()
        lexer.start(input, startOffset, input.length, 0)

        val out = mutableListOf<LexedToken>()
        while (true) {
            val tokenType = lexer.tokenType ?: break
            out += LexedToken(
                type = tokenType.toString(),
                text = input.substring(lexer.tokenStart, lexer.tokenEnd),
            )
            lexer.advance()
        }
        return out
    }

    @Test
    fun tokenizesDecoratorsInsideCommentLines() {
        val tokens = lex("# @required @type=enum(prod, dev)")

        val decoratorTexts = tokens
            .filter { it.type == EnvSpecTokenTypes.DECORATOR.toString() }
            .map { it.text }
        assertEquals(listOf("@required", "@type"), decoratorTexts)

        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.LINE_COMMENT.toString() && it.text.contains("#") })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_VALUE.toString() && it.text == "enum" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "prod" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "dev" })
    }

    @Test
    fun tokenizesDecoratorFunctionArgs() {
        val tokens = lex("# @generateTypes(lang='ts', path='env.d.ts')")
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR.toString() && it.text == "@generateTypes" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text == "lang" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "'ts'" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text == "path" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "'env.d.ts'" })
    }

    @Test
    fun tokenizesTypeOptionKeyValueInsideDecoratorArgs() {
        val tokens = lex("# @type=string(startsWith=sk_, matches=test, maxLength=29, )")
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text == "startsWith" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "sk_" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text == "matches" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "test" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text == "maxLength" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "29" })
    }

    @Test
    fun tokenizesSubsequentArgsConsistentlyWithoutClosingParen() {
        val tokens = lex("# @type=string(startsWith=sk____, matches=test, maxLength=29, minLength=jifdpajaf")
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text == "startsWith" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "sk____" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text == "matches" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "test" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text == "maxLength" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "29" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text == "minLength" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "jifdpajaf" })
    }

    @Test
    fun tokenizesSubsequentArgsConsistentlyWithClosingParen() {
        val tokens = lex("# @type=string(startsWith=sk____, matches=test, maxLength=29, minLength=jifdpajaf)")
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text == "startsWith" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "sk____" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text == "matches" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "test" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text == "maxLength" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "29" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text == "minLength" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text == "jifdpajaf" })
    }

    @Test
    fun keepsDecoratorArgKeyValueHighlightingWhenLexingStartsMidLine() {
        val input = "# @type=string(startsWith=sk____, matches=test, maxLength=29, minLength=jifdpajaf)"
        val midOffset = input.indexOf("matches")
        val tokens = lexFromOffset(input, midOffset)

        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text.contains("matches") })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text.contains("test") })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text.contains("maxLength") })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text.contains("29") })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_KEY.toString() && it.text.contains("minLength") })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.DECORATOR_ARG_VALUE.toString() && it.text.contains("jifdpajaf") })
    }

    @Test
    fun tokenizesAssignmentValueFunctionsAndReferences() {
        val tokens = lex("""URL=if(eq(${'$'}ENV, "prod"), "https://api.example.com", "https://staging-api.example.com")""")
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.VALUE_FUNCTION.toString() && it.text == "if" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.VALUE_FUNCTION.toString() && it.text == "eq" })
        assertTrue(tokens.any { it.type == EnvSpecTokenTypes.VALUE_REFERENCE.toString() && it.text == "\$ENV" })
    }
}
