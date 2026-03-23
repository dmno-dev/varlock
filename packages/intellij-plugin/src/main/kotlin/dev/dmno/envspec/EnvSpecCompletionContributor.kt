package dev.dmno.envspec

import com.intellij.codeInsight.completion.CompletionContributor
import com.intellij.codeInsight.completion.CompletionParameters
import com.intellij.codeInsight.completion.CompletionProvider
import com.intellij.codeInsight.completion.CompletionResultSet
import com.intellij.codeInsight.completion.CompletionType
import com.intellij.codeInsight.completion.InsertHandler
import com.intellij.codeInsight.completion.InsertionContext
import com.intellij.codeInsight.lookup.LookupElement
import com.intellij.codeInsight.lookup.LookupElementBuilder
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.patterns.PlatformPatterns
import com.intellij.util.ProcessingContext
import java.util.regex.Pattern

class EnvSpecCompletionContributor : CompletionContributor() {

    init {
        extend(CompletionType.BASIC, PlatformPatterns.psiElement().withLanguage(EnvSpecLanguage),
            object : CompletionProvider<CompletionParameters>() {
                override fun addCompletions(parameters: CompletionParameters, context: ProcessingContext, result: CompletionResultSet) {
                    doAddCompletions(parameters, result)
                }
            })
    }

    companion object {
        private val ENV_KEY_PATTERN = Pattern.compile("^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\\s*=")
        private val KOTLIN_ESCAPED_DOLLAR_RE = Regex("\\$\\{'\\$'\\}")
        private val CHOICE_SNIPPET_RE = Regex("""\$\{\d+\|([^}]*)\|\}""")
        private val DEFAULT_SNIPPET_RE = Regex("""\$\{\d+:([^}]*)\}""")
        private val TABSTOP_SNIPPET_RE = Regex("""\$\{\d+\}""")
        private val SIMPLE_TABSTOP_SNIPPET_RE = Regex("""\$\d+""")
    }

    private fun getDecoratorCommentPrefix(linePrefix: String): String? {
        return EnvSpecDiagnosticsCore.getDecoratorCommentText(linePrefix)
    }

    private fun doAddCompletions(params: CompletionParameters, result: CompletionResultSet) {
        val file = params.originalFile as? EnvSpecFile ?: return
        val document = params.editor.document
        val offset = params.offset
        val line = document.getLineNumber(offset)
        val lineStart = document.getLineStartOffset(line)
        val linePrefix = document.getText(com.intellij.openapi.util.TextRange(lineStart, offset))
        val commentPrefix = getDecoratorCommentPrefix(linePrefix)

        val lineDocument = object : LineDocument {
            override val lineCount: Int get() = document.lineCount
            override fun lineAt(l: Int): LineInfo = LineInfo(document.getText(com.intellij.openapi.util.TextRange(document.getLineStartOffset(l), document.getLineEndOffset(l))))
        }

        // $KEY reference completion
        val referenceContext = matchReference(linePrefix, line, offset, lineStart)
        if (referenceContext != null) {
            createReferenceItems(lineDocument, referenceContext).forEach { result.addElement(it) }
            return
        }

        // Enum value completion
        val enumValueContext = getEnumValueContext(lineDocument, line, linePrefix, lineStart, offset)
        if (enumValueContext != null) {
            createEnumValueItems(enumValueContext).forEach { result.addElement(it) }
            return
        }

        if (commentPrefix != null) {
            val existingDecoratorNames = EnvSpecCompletionCore.getExistingDecoratorNames(lineDocument, line, commentPrefix)

            // Type option completion
            val typeOptionContext = matchTypeOption(commentPrefix, line, offset, lineStart)
            if (typeOptionContext != null) {
                typeOptionContext.dataType.optionSnippets!!.forEach { option ->
                    result.addElement(createDataTypeOptionItem(option, typeOptionContext))
                }
                return
            }

            // @type= completion
            val typeContext = matchTypeValue(commentPrefix, line, offset, lineStart)
            if (typeContext != null) {
                EnvSpecCatalog.DATA_TYPES.forEach { result.addElement(createDataTypeItem(it, typeContext)) }
                return
            }

            // Decorator value completion
            val decoratorValueContext = matchDecoratorValue(commentPrefix, line, offset, lineStart)
            if (decoratorValueContext != null) {
                createDecoratorValueItems(lineDocument, decoratorValueContext).forEach { result.addElement(it) }
                return
            }

            // Decorator completion
            val decoratorContext = matchDecoratorName(commentPrefix, line, offset, lineStart)
            if (decoratorContext != null) {
                val decorators = if (EnvSpecCompletionCore.isInHeader(lineDocument, line)) EnvSpecCatalog.ROOT_DECORATORS else EnvSpecCatalog.ITEM_DECORATORS
                EnvSpecCompletionCore.filterAvailableDecorators(decorators, existingDecoratorNames).forEach {
                    result.addElement(createDecoratorItem(it, decoratorContext))
                }
                return
            }
        }

        // Resolver completion
        val resolverContext = matchResolverValue(linePrefix, line, offset, lineStart)
        if (resolverContext != null) {
            EnvSpecCatalog.RESOLVERS.forEach { result.addElement(createResolverItem(it, resolverContext)) }
        }
    }

    private data class ReplaceRange(val line: Int, val start: Int, val end: Int)

    override fun invokeAutoPopup(position: com.intellij.psi.PsiElement, typeChar: Char): Boolean {
        return typeChar == '@' || typeChar == '$' || typeChar == '=' || typeChar == ','
    }

    private fun matchDecoratorName(commentPrefix: String, line: Int, offset: Int, lineStart: Int): ReplaceRange? {
        val match = Regex("(^|\\s)(@[\\w-]*)$").find(commentPrefix) ?: return null
        val token = match.groupValues[2]
        val endInLine = offset - lineStart
        return ReplaceRange(line, endInLine - token.length, endInLine)
    }

    private fun matchTypeValue(commentPrefix: String, line: Int, offset: Int, lineStart: Int): ReplaceRange? {
        val match = Regex("(^|\\s)@type=([\\w-]*)$").find(commentPrefix) ?: return null
        val typedValue = match.groupValues[2]
        val endInLine = offset - lineStart
        return ReplaceRange(line, endInLine - typedValue.length, endInLine)
    }

    private fun matchTypeOption(commentPrefix: String, line: Int, offset: Int, lineStart: Int): ReplaceRangeData? {
        val dataType = EnvSpecCompletionCore.getTypeOptionDataType(EnvSpecCatalog.DATA_TYPES, commentPrefix) ?: return null
        if (dataType.optionSnippets.isNullOrEmpty()) return null
        val match = Regex("(^|\\s)@type=([A-Za-z][\\w-]*)\\((?:[^#)]*?,\\s*)?([\\w-]*)$").find(commentPrefix) ?: return null
        val typedValue = match.groupValues[3]
        val endInLine = offset - lineStart
        return ReplaceRangeData(dataType, ReplaceRange(line, endInLine - typedValue.length, endInLine))
    }

    private data class ReplaceRangeData(val dataType: DataTypeInfo, val range: ReplaceRange)

    private fun matchReference(linePrefix: String, line: Int, offset: Int, lineStart: Int): ReplaceRange? {
        val match = Regex("\\$([A-Za-z0-9_]*)$").find(linePrefix) ?: return null
        val endInLine = offset - lineStart
        return ReplaceRange(line, endInLine - match.value.length, endInLine)
    }

    private fun matchResolverValue(linePrefix: String, line: Int, offset: Int, lineStart: Int): ReplaceRange? {
        val match = Regex("(?:=\\s*|[(,]\\s*)([A-Za-z]?[\\w-]*)$").find(linePrefix) ?: return null
        val endInLine = offset - lineStart
        return ReplaceRange(line, endInLine - match.groupValues[1].length, endInLine)
    }

    private fun matchDecoratorValue(commentPrefix: String, line: Int, offset: Int, lineStart: Int): ReplaceRangeDecorator? {
        val match = Regex("(^|\\s)@([\\w-]+)=([A-Za-z]?[\\w-]*)$").find(commentPrefix) ?: return null
        val decorator = EnvSpecCatalog.DECORATORS_BY_NAME[match.groupValues[2]]
        val typedValue = match.groupValues[3]
        val endInLine = offset - lineStart
        return ReplaceRangeDecorator(decorator, ReplaceRange(line, endInLine - typedValue.length, endInLine))
    }

    private data class ReplaceRangeDecorator(val decorator: DecoratorInfo?, val range: ReplaceRange)

    private fun matchItemValue(linePrefix: String, line: Int, offset: Int, lineStart: Int): ReplaceRange? {
        val match = Regex("^\\s*[A-Za-z_][A-Za-z0-9._-]*\\s*=\\s*([A-Za-z0-9._-]*)$").find(linePrefix) ?: return null
        val typedValue = match.groupValues[1]
        val endInLine = offset - lineStart
        return ReplaceRange(line, endInLine - typedValue.length, endInLine)
    }

    private fun getEnumValueContext(document: LineDocument, line: Int, linePrefix: String, lineStart: Int, offset: Int): EnumValueContext? {
        val itemContext = matchItemValue(linePrefix, line, offset, lineStart) ?: return null
        val enumValues = EnvSpecCompletionCore.getEnumValuesFromPrecedingComments(document, line) ?: return null
        return EnumValueContext(itemContext, enumValues)
    }

    private data class EnumValueContext(val range: ReplaceRange, val enumValues: List<String>)

    private fun createDecoratorItem(info: DecoratorInfo, range: ReplaceRange): LookupElementBuilder {
        val insertHandler = createReplaceHandler(info.insertText)
        var item = LookupElementBuilder.create("@${info.name}")
            .withInsertHandler(insertHandler)
            .withTypeText(if (info.scope == "root") "Root decorator" else "Item decorator")
            .withTailText(" " + info.insertText, true)
        if (info.deprecated != null) {
            item = item.withStrikeoutness(true)
        }
        return item
    }

    private fun createReplaceHandler(insertText: String, caretOffsetInInsert: Int? = null): InsertHandler<LookupElement> {
        val normalizedInsertText = normalizeSnippetInsertText(insertText)
        return InsertHandler { ctx: InsertionContext, _ ->
            WriteCommandAction.runWriteCommandAction(ctx.project) {
                val doc = ctx.document
                // IntelliJ applies default completion insertion before this handler runs.
                // Replace that inserted segment directly to avoid duplicate/append behavior.
                val start = ctx.startOffset
                val end = ctx.tailOffset
                val hasAtPrefix = start > 0 && doc.charsSequence[start - 1] == '@'
                val textToInsert = if (hasAtPrefix && normalizedInsertText.startsWith("@")) {
                    normalizedInsertText.substring(1)
                } else {
                    normalizedInsertText
                }
                ctx.setAddCompletionChar(false)
                doc.replaceString(start, end, textToInsert)
                ctx.tailOffset = start + textToInsert.length
                val caretOffset = if (caretOffsetInInsert == null) {
                    start + textToInsert.length
                } else {
                    start + caretOffsetInInsert.coerceIn(0, textToInsert.length)
                }
                ctx.editor.caretModel.moveToOffset(caretOffset)
            }
        }
    }

    private fun normalizeSnippetInsertText(text: String): String {
        var out = text
        out = KOTLIN_ESCAPED_DOLLAR_RE.replace(out) { "$" }
        out = CHOICE_SNIPPET_RE.replace(out) { match ->
            match.groupValues[1].split(",").firstOrNull()?.trim().orEmpty()
        }
        out = DEFAULT_SNIPPET_RE.replace(out) { match -> match.groupValues[1] }
        out = TABSTOP_SNIPPET_RE.replace(out, "")
        out = SIMPLE_TABSTOP_SNIPPET_RE.replace(out, "")
        return out
    }

    private fun createDataTypeItem(info: DataTypeInfo, range: ReplaceRange): LookupElementBuilder {
        val insertText = info.insertText ?: info.name
        return LookupElementBuilder.create(info.name)
            .withInsertHandler(createReplaceHandler(insertText))
            .withTypeText("@type data type")
            .withTailText(" ${info.summary}", true)
    }

    private fun createDataTypeOptionItem(option: DataTypeOptionSnippet, context: ReplaceRangeData): LookupElementBuilder {
        val range = context.range
        val insertText = "${option.name}="
        return LookupElementBuilder.create(option.name)
            .withInsertHandler(createReplaceHandler(insertText, insertText.length))
            .withTypeText("@type option")
            .withTailText(" ${option.documentation}", true)
    }

    private fun createResolverItem(info: ResolverInfo, range: ReplaceRange): LookupElementBuilder {
        return LookupElementBuilder.create("${info.name}()")
            .withInsertHandler(createReplaceHandler(info.insertText))
            .withTypeText("Resolver function")
            .withTailText(" ${info.summary}", true)
    }

    private fun createReferenceItems(document: LineDocument, range: ReplaceRange): List<LookupElementBuilder> {
        val keys = mutableSetOf("VARLOCK_ENV")
        for (i in 0 until document.lineCount) {
            val matcher = ENV_KEY_PATTERN.matcher(document.lineAt(i).text)
            if (matcher.find()) keys.add(matcher.group(1))
        }
        return keys.sorted().map { key ->
            LookupElementBuilder.create(key)
                .withInsertHandler(createReplaceHandler(key))
                .withTypeText("Config item reference")
                .withTailText(" Reference `$key` with `\$$key`.", true)
        }
    }

    private fun createKeywordItems(values: List<String>, range: ReplaceRange): List<LookupElementBuilder> {
        return values.map { value ->
            LookupElementBuilder.create(value)
                .withInsertHandler(createReplaceHandler(value))
        }
    }

    private fun createDecoratorValueItems(document: LineDocument, context: ReplaceRangeDecorator): List<LookupElementBuilder> {
        return when (context.decorator?.name) {
            "currentEnv" -> createReferenceItems(document, context.range)
            "defaultRequired" -> createKeywordItems(listOf("infer", "true", "false"), context.range)
            "defaultSensitive" -> createKeywordItems(listOf("true", "false"), context.range) +
                EnvSpecCatalog.RESOLVERS.filter { it.name == "inferFromPrefix" }.map { createResolverItem(it, context.range) }
            "required", "optional", "sensitive", "public", "disable" -> createKeywordItems(listOf("true", "false"), context.range) +
                EnvSpecCatalog.RESOLVERS.filter { it.name in listOf("forEnv", "eq", "if", "not", "isEmpty") }.map { createResolverItem(it, context.range) }
            else -> emptyList()
        }
    }

    private fun createEnumValueItems(context: EnumValueContext): List<LookupElementBuilder> {
        val range = context.range
        return context.enumValues.map { value ->
            LookupElementBuilder.create(value)
                .withInsertHandler(createReplaceHandler(value))
                .withTypeText("@type=enum value")
                .withTailText(" Allowed enum value `$value`.", true)
        }
    }
}
