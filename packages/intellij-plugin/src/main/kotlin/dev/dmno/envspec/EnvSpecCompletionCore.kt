package dev.dmno.envspec

interface LineDocument {
    val lineCount: Int
    fun lineAt(line: Int): LineInfo
}

data class LineInfo(val text: String)

object EnvSpecCompletionCore {

    private val HEADER_SEPARATOR_PATTERN = Regex("^\\s*#\\s*---+\\s*$")
    private val DECORATOR_PATTERN = Regex("@([A-Za-z][\\w-]*)")
    private val INCOMPATIBLE_DECORATORS = mapOf(
        "required" to setOf("optional"),
        "optional" to setOf("required"),
        "sensitive" to setOf("public"),
        "public" to setOf("sensitive"),
    )

    fun isInHeader(document: LineDocument, lineNumber: Int): Boolean {
        for (line in lineNumber downTo 0) {
            if (HEADER_SEPARATOR_PATTERN.containsMatchIn(document.lineAt(line).text)) return false
        }
        return true
    }

    fun getExistingDecoratorNames(document: LineDocument, lineNumber: Int, commentPrefix: String): Set<String> {
        val names = mutableSetOf<String>()
        for (line in lineNumber - 1 downTo 0) {
            val text = document.lineAt(line).text.trim()
            if (!text.startsWith("#")) break
            DECORATOR_PATTERN.findAll(text).forEach { names.add(it.groupValues[1]) }
        }
        DECORATOR_PATTERN.findAll(commentPrefix).forEach { names.add(it.groupValues[1]) }
        return names
    }

    fun filterAvailableDecorators(decorators: List<DecoratorInfo>, existingDecoratorNames: Set<String>): List<DecoratorInfo> {
        return decorators.filter { decorator ->
            if (!decorator.isFunction && existingDecoratorNames.contains(decorator.name)) return@filter false
            val incompatible = INCOMPATIBLE_DECORATORS[decorator.name] ?: return@filter true
            !incompatible.any { existingDecoratorNames.contains(it) }
        }
    }

    fun splitEnumArgs(input: String): List<String> {
        return splitArgs(input).map { it.replace(Regex("^['\"]|['\"]$"), "").trim() }.filter { it.isNotEmpty() }
    }

    fun getEnumValuesFromPrecedingComments(document: LineDocument, lineNumber: Int): List<String>? {
        for (line in lineNumber - 1 downTo 0) {
            val text = document.lineAt(line).text.trim()
            if (!text.startsWith("#")) break
            val match = Regex("@type=enum\\((.*)\\)").find(text) ?: continue
            return splitEnumArgs(match.groupValues[1])
        }
        return null
    }

    fun getTypeOptionDataType(dataTypes: List<DataTypeInfo>, commentPrefix: String): DataTypeInfo? {
        val match = Regex("(^|\\s)@type=([A-Za-z][\\w-]*)\\([^#)]*$").find(commentPrefix) ?: return null
        return dataTypes.find { it.name == match.groupValues[2] }
    }

    private fun splitArgs(input: String): List<String> {
        val parts = mutableListOf<String>()
        var current = ""
        var quote: Char? = null
        var depth = 0
        for (char in input) {
            when {
                quote != null -> {
                    current += char
                    if (char == quote) quote = null
                }
                char == '"' || char == '\'' -> {
                    quote = char
                    current += char
                }
                char == '(' -> {
                    depth++
                    current += char
                }
                char == ')' -> {
                    depth = maxOf(depth - 1, 0)
                    current += char
                }
                char == ',' && depth == 0 -> {
                    val value = current.trim()
                    if (value.isNotEmpty()) parts.add(value)
                    current = ""
                }
                else -> current += char
            }
        }
        val value = current.trim()
        if (value.isNotEmpty()) parts.add(value)
        return parts
    }
}
