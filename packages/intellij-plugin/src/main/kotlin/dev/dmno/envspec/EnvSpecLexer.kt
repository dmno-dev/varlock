package dev.dmno.envspec

import com.intellij.lexer.LexerBase
import com.intellij.psi.TokenType
import com.intellij.psi.tree.IElementType

class EnvSpecLexer : LexerBase() {

    private var buffer: CharSequence = ""
    private var bufferEnd = 0
    private var tokenStart = 0
    private var tokenEnd = 0
    private var tokenType: IElementType? = null

    override fun start(buffer: CharSequence, startOffset: Int, endOffset: Int, initialState: Int) {
        this.buffer = buffer
        this.bufferEnd = endOffset
        this.tokenStart = startOffset
        this.tokenEnd = startOffset
        advance()
    }

    override fun getState(): Int = 0

    override fun getTokenType(): IElementType? = tokenType

    override fun getTokenStart(): Int = tokenStart

    override fun getTokenEnd(): Int = tokenEnd

    override fun getBufferSequence(): CharSequence = buffer

    override fun getBufferEnd(): Int = bufferEnd

    override fun advance() {
        tokenStart = tokenEnd
        if (tokenEnd >= bufferEnd) {
            tokenType = null
            return
        }
        val c = buffer[tokenEnd]
        when (c) {
            '\r' -> {
                tokenEnd++
                if (tokenEnd < bufferEnd && buffer[tokenEnd] == '\n') tokenEnd++
                tokenType = EnvSpecTokenTypes.NEWLINE
            }
            '\n' -> {
                tokenEnd++
                tokenType = EnvSpecTokenTypes.NEWLINE
            }
            else -> {
                while (tokenEnd < bufferEnd && buffer[tokenEnd] != '\r' && buffer[tokenEnd] != '\n') {
                    tokenEnd++
                }
                tokenType = EnvSpecTokenTypes.LINE_CONTENT
            }
        }
    }
}
