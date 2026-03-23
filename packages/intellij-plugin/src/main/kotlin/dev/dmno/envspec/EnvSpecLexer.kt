package dev.dmno.envspec

import com.intellij.lexer.LexerBase
import com.intellij.psi.TokenType
import com.intellij.psi.tree.IElementType

/**
 * Line-oriented lexer: comments (#…), assignments (optional export, KEY=value), or unparsed line content.
 */
class EnvSpecLexer : LexerBase() {

    private var buffer: CharSequence = ""
    private var bufferEnd = 0
    private var tokenStart = 0
    private var tokenEnd = 0
    private var tokenType: IElementType? = null

    private val queue = ArrayList<QueuedToken>(8)
    private var queuePos = 0

    private data class QueuedToken(val start: Int, val end: Int, val type: IElementType)

    override fun start(buffer: CharSequence, startOffset: Int, endOffset: Int, initialState: Int) {
        this.buffer = buffer
        this.bufferEnd = endOffset
        this.tokenEnd = startOffset
        this.queue.clear()
        this.queuePos = 0
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
        if (pollQueue()) return

        queue.clear()
        queuePos = 0

        if (tokenEnd >= bufferEnd) {
            tokenType = null
            return
        }

        val ch = buffer[tokenEnd]
        if (ch == '\r' || ch == '\n') {
            emitNewlineAt(tokenEnd)
            return
        }

        val lineStart = findLineStart(tokenEnd)
        val lineEnd = findLineEnd(lineStart)
        enqueueLineTokens(lineStart, lineEnd)
        trimQueuedTokensBefore(tokenEnd)
        enqueueNewlineAfterLine(lineEnd)
        trimQueuedTokensBefore(tokenEnd)

        if (!pollQueue()) {
            tokenType = null
        }
    }

    private fun trimQueuedTokensBefore(offset: Int) {
        if (queue.isEmpty()) return
        val trimmed = ArrayList<QueuedToken>(queue.size)
        for (token in queue) {
            if (token.end <= offset) continue
            if (token.start < offset) {
                trimmed.add(QueuedToken(offset, token.end, token.type))
            } else {
                trimmed.add(token)
            }
        }
        queue.clear()
        queue.addAll(trimmed)
        queuePos = 0
    }

    private fun findLineStart(from: Int): Int {
        var i = from
        while (i > 0) {
            val prev = buffer[i - 1]
            if (prev == '\n' || prev == '\r') break
            i--
        }
        return i
    }

    private fun pollQueue(): Boolean {
        if (queuePos >= queue.size) return false
        val t = queue[queuePos++]
        tokenStart = t.start
        tokenEnd = t.end
        tokenType = t.type
        return true
    }

    private fun findLineEnd(from: Int): Int {
        var i = from
        while (i < bufferEnd && buffer[i] != '\n' && buffer[i] != '\r') i++
        return i
    }

    private fun enqueueNewlineAfterLine(lineEnd: Int) {
        if (lineEnd >= bufferEnd) return
        var end = lineEnd
        if (buffer[end] == '\r') {
            end++
            if (end < bufferEnd && buffer[end] == '\n') end++
        } else if (buffer[end] == '\n') {
            end++
        }
        queue.add(QueuedToken(lineEnd, end, EnvSpecTokenTypes.NEWLINE))
    }

    private fun emitNewlineAt(from: Int) {
        var end = from
        if (end < bufferEnd && buffer[end] == '\r') {
            end++
            if (end < bufferEnd && buffer[end] == '\n') end++
        } else if (end < bufferEnd && buffer[end] == '\n') {
            end++
        }
        tokenStart = from
        tokenEnd = end
        tokenType = EnvSpecTokenTypes.NEWLINE
    }

    private fun enqueueLineTokens(lineStart: Int, lineEnd: Int) {
        if (lineStart >= lineEnd) return

        val lineStr = buffer.subSequence(lineStart, lineEnd).toString()

        if (lineStr.isBlank()) {
            queue.add(QueuedToken(lineStart, lineEnd, TokenType.WHITE_SPACE))
            return
        }

        val comment = COMMENT_LINE.matchEntire(lineStr)
        if (comment != null) {
            val ws = comment.groupValues[1]
            val wsLen = ws.length
            if (wsLen > 0) {
                queue.add(QueuedToken(lineStart, lineStart + wsLen, TokenType.WHITE_SPACE))
            }
            enqueueCommentTokens(lineStart + wsLen, lineEnd)
            return
        }

        val assign = ASSIGNMENT_LINE.matchEntire(lineStr)
        if (assign != null) {
            val wsLead = assign.groups[1]!!.range
            val export = assign.groups[2]
            val key = assign.groups[3]!!.range
            val wsMid = assign.groups[4]!!.range
            val eq = assign.groups[5]!!.range
            val value = assign.groups[6]!!.range

            if (!wsLead.isEmpty()) {
                queue.add(QueuedToken(lineStart + wsLead.first, lineStart + wsLead.last + 1, TokenType.WHITE_SPACE))
            }
            if (export != null) {
                val r = export.range
                queue.add(QueuedToken(lineStart + r.first, lineStart + r.last + 1, EnvSpecTokenTypes.EXPORT_KEYWORD))
            }
            queue.add(QueuedToken(lineStart + key.first, lineStart + key.last + 1, EnvSpecTokenTypes.ENV_KEY))
            if (!wsMid.isEmpty()) {
                queue.add(QueuedToken(lineStart + wsMid.first, lineStart + wsMid.last + 1, TokenType.WHITE_SPACE))
            }
            queue.add(QueuedToken(lineStart + eq.first, lineStart + eq.last + 1, EnvSpecTokenTypes.EQUALS))
            if (!value.isEmpty()) {
                val valueStart = lineStart + value.first
                val valueText = lineStr.substring(value.first, value.last + 1)
                enqueueAssignmentValueTokens(valueStart, valueText)
            }
            return
        }

        queue.add(QueuedToken(lineStart, lineEnd, EnvSpecTokenTypes.LINE_CONTENT))
    }

    private fun enqueueCommentTokens(start: Int, end: Int) {
        if (start >= end) return
        val text = buffer.subSequence(start, end).toString()
        var i = 0
        var plainStart = 0

        while (i < text.length) {
            val atIndex = text.indexOf('@', i)
            if (atIndex < 0) break

            if (atIndex + 1 >= text.length || !isDecoratorNameStart(text[atIndex + 1])) {
                i = atIndex + 1
                continue
            }

            if (atIndex > plainStart) {
                queue.add(QueuedToken(start + plainStart, start + atIndex, EnvSpecTokenTypes.LINE_COMMENT))
            }

            var nameEnd = atIndex + 2
            while (nameEnd < text.length && isDecoratorNamePart(text[nameEnd])) nameEnd++
            queue.add(QueuedToken(start + atIndex, start + nameEnd, EnvSpecTokenTypes.DECORATOR))

            i = nameEnd
            plainStart = i

            if (i < text.length && text[i] == '=') {
                queue.add(QueuedToken(start + i, start + i + 1, EnvSpecTokenTypes.EQUALS))
                i++
                val valueStart = i
                if (i < text.length && isDecoratorValueNameStart(text[i])) {
                    var valueEnd = i + 1
                    while (valueEnd < text.length && isDecoratorValueNamePart(text[valueEnd])) valueEnd++
                    queue.add(QueuedToken(start + i, start + valueEnd, EnvSpecTokenTypes.DECORATOR_VALUE))
                    i = valueEnd
                    if (i < text.length && text[i] == '(') {
                        queue.add(QueuedToken(start + i, start + i + 1, EnvSpecTokenTypes.EQUALS))
                        val close = findClosingParen(text, i)
                        if (close > i + 1) {
                            enqueueDecoratorArgsTokens(start + i + 1, text.substring(i + 1, close))
                        }
                        if (close < text.length) {
                            queue.add(QueuedToken(start + close, start + close + 1, EnvSpecTokenTypes.EQUALS))
                            i = close + 1
                        } else {
                            i = text.length
                        }
                    }
                } else {
                    var valueEnd = i
                    while (valueEnd < text.length && !text[valueEnd].isWhitespace() && text[valueEnd] != '#') valueEnd++
                    if (valueEnd > valueStart) {
                        queue.add(QueuedToken(start + valueStart, start + valueEnd, EnvSpecTokenTypes.DECORATOR_VALUE))
                    }
                    i = valueEnd
                }
                plainStart = i
                continue
            }

            if (i < text.length && text[i] == '(') {
                queue.add(QueuedToken(start + i, start + i + 1, EnvSpecTokenTypes.EQUALS))
                val close = findClosingParen(text, i)
                if (close > i + 1) {
                    enqueueDecoratorArgsTokens(start + i + 1, text.substring(i + 1, close))
                }
                if (close < text.length) {
                    queue.add(QueuedToken(start + close, start + close + 1, EnvSpecTokenTypes.EQUALS))
                    i = close + 1
                } else {
                    i = text.length
                }
                plainStart = i
                continue
            }

            plainStart = i
        }

        if (plainStart < text.length) {
            queue.add(QueuedToken(start + plainStart, end, EnvSpecTokenTypes.LINE_COMMENT))
        }
    }

    private fun enqueueDecoratorArgsTokens(argsStartOffset: Int, argsText: String) {
        if (argsText.isEmpty()) return

        var segmentStart = 0
        var i = 0
        var depth = 0
        var quote: Char? = null

        while (i < argsText.length) {
            val ch = argsText[i]
            when {
                quote != null -> if (ch == quote) quote = null
                ch == '\'' || ch == '"' || ch == '`' -> quote = ch
                ch == '(' -> depth++
                ch == ')' -> if (depth > 0) depth--
                ch == ',' && depth == 0 -> {
                    enqueueDecoratorArgSegment(argsStartOffset + segmentStart, argsText.substring(segmentStart, i))
                    queue.add(QueuedToken(argsStartOffset + i, argsStartOffset + i + 1, EnvSpecTokenTypes.EQUALS))
                    segmentStart = i + 1
                }
            }
            i++
        }

        if (segmentStart < argsText.length) {
            enqueueDecoratorArgSegment(argsStartOffset + segmentStart, argsText.substring(segmentStart))
        }
    }

    private fun enqueueDecoratorArgSegment(segmentStartOffset: Int, segmentText: String) {
        if (segmentText.isEmpty()) return

        val leadingWs = segmentText.takeWhile { it.isWhitespace() }.length
        val trailingWs = segmentText.takeLastWhile { it.isWhitespace() }.length
        val coreStart = leadingWs
        val coreEnd = segmentText.length - trailingWs

        if (leadingWs > 0) {
            queue.add(QueuedToken(segmentStartOffset, segmentStartOffset + leadingWs, TokenType.WHITE_SPACE))
        }
        if (coreStart >= coreEnd) {
            return
        }

        val core = segmentText.substring(coreStart, coreEnd)
        val coreAbsStart = segmentStartOffset + coreStart
        val eqIdx = findTopLevelEquals(core)
        val keyCandidateEnd = if (eqIdx > 0) core.substring(0, eqIdx).trimEnd().length else -1
        val hasKeyValueShape = keyCandidateEnd > 0 &&
            core.substring(0, keyCandidateEnd).matches(Regex("""[A-Za-z][A-Za-z0-9_-]*"""))

        if (!hasKeyValueShape) {
            queue.add(QueuedToken(coreAbsStart, coreAbsStart + core.length, EnvSpecTokenTypes.DECORATOR_ARG_VALUE))
        } else {
            queue.add(QueuedToken(coreAbsStart, coreAbsStart + keyCandidateEnd, EnvSpecTokenTypes.DECORATOR_ARG_KEY))
            var cursor = keyCandidateEnd
            while (cursor < eqIdx) {
                queue.add(QueuedToken(coreAbsStart + cursor, coreAbsStart + cursor + 1, TokenType.WHITE_SPACE))
                cursor++
            }
            queue.add(QueuedToken(coreAbsStart + eqIdx, coreAbsStart + eqIdx + 1, EnvSpecTokenTypes.EQUALS))
            if (eqIdx + 1 < core.length) {
                queue.add(QueuedToken(coreAbsStart + eqIdx + 1, coreAbsStart + core.length, EnvSpecTokenTypes.DECORATOR_ARG_VALUE))
            }
        }

        if (trailingWs > 0) {
            queue.add(QueuedToken(segmentStartOffset + coreEnd, segmentStartOffset + segmentText.length, TokenType.WHITE_SPACE))
        }
    }

    private fun findTopLevelEquals(text: String): Int {
        var depth = 0
        var quote: Char? = null
        for (i in text.indices) {
            val ch = text[i]
            when {
                quote != null -> if (ch == quote) quote = null
                ch == '\'' || ch == '"' || ch == '`' -> quote = ch
                ch == '(' -> depth++
                ch == ')' -> if (depth > 0) depth--
                ch == '=' && depth == 0 -> return i
            }
        }
        return -1
    }

    private fun enqueueAssignmentValueTokens(valueStartOffset: Int, valueText: String) {
        var i = 0
        var plainStart = 0
        var quote: Char? = null

        while (i < valueText.length) {
            val ch = valueText[i]
            if (quote != null) {
                if (ch == quote) quote = null
                i++
                continue
            }
            if (ch == '"' || ch == '\'' || ch == '`') {
                quote = ch
                i++
                continue
            }

            if (ch == '$') {
                val refEnd = findReferenceEnd(valueText, i)
                if (refEnd > i + 1) {
                    if (i > plainStart) {
                        queue.add(QueuedToken(valueStartOffset + plainStart, valueStartOffset + i, EnvSpecTokenTypes.ENV_VALUE))
                    }
                    queue.add(QueuedToken(valueStartOffset + i, valueStartOffset + refEnd, EnvSpecTokenTypes.VALUE_REFERENCE))
                    i = refEnd
                    plainStart = i
                    continue
                }
            }

            if (isValueFunctionNameStart(ch)) {
                val nameStart = i
                var nameEnd = i + 1
                while (nameEnd < valueText.length && isDecoratorValueNamePart(valueText[nameEnd])) nameEnd++
                if (nameEnd < valueText.length && valueText[nameEnd] == '(') {
                    if (nameStart > plainStart) {
                        queue.add(QueuedToken(valueStartOffset + plainStart, valueStartOffset + nameStart, EnvSpecTokenTypes.ENV_VALUE))
                    }
                    queue.add(QueuedToken(valueStartOffset + nameStart, valueStartOffset + nameEnd, EnvSpecTokenTypes.VALUE_FUNCTION))
                    i = nameEnd
                    plainStart = i
                    continue
                }
            }
            i++
        }

        if (plainStart < valueText.length) {
            queue.add(QueuedToken(valueStartOffset + plainStart, valueStartOffset + valueText.length, EnvSpecTokenTypes.ENV_VALUE))
        }
    }

    private fun findReferenceEnd(text: String, dollarIndex: Int): Int {
        if (dollarIndex + 1 >= text.length) return dollarIndex + 1
        if (text[dollarIndex + 1] == '{') {
            var i = dollarIndex + 2
            while (i < text.length && text[i] != '}') i++
            return if (i < text.length) i + 1 else dollarIndex + 1
        }
        var i = dollarIndex + 1
        if (!isRefNameStart(text[i])) return dollarIndex + 1
        i++
        while (i < text.length && isRefNamePart(text[i])) i++
        return i
    }

    private fun findClosingParen(text: String, openIndex: Int): Int {
        var depth = 0
        var i = openIndex
        while (i < text.length) {
            when (text[i]) {
                '(' -> depth++
                ')' -> {
                    depth--
                    if (depth == 0) return i
                }
            }
            i++
        }
        return text.length
    }

    private fun isDecoratorNameStart(ch: Char): Boolean = ch.isLetter()
    private fun isDecoratorNamePart(ch: Char): Boolean = ch.isLetterOrDigit() || ch == '_' || ch == '-'
    private fun isDecoratorValueNameStart(ch: Char): Boolean = ch.isLetter()
    private fun isDecoratorValueNamePart(ch: Char): Boolean = ch.isLetterOrDigit() || ch == '_' || ch == '-'
    private fun isValueFunctionNameStart(ch: Char): Boolean = ch.isLetter()
    private fun isRefNameStart(ch: Char): Boolean = ch.isLetter() || ch == '_'
    private fun isRefNamePart(ch: Char): Boolean = ch.isLetterOrDigit() || ch == '_'

    companion object {
        private val COMMENT_LINE = Regex("""^([ \t]*)(#.*)$""")
        private val ASSIGNMENT_LINE = Regex("""^([ \t]*)(export[ \t]+)?([A-Za-z_][\w.-]*)([ \t]*)(=)(.*)$""")
    }
}
