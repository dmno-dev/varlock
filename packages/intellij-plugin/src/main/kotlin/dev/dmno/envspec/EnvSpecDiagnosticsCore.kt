package dev.dmno.envspec

import java.net.InetAddress
import java.net.URI

object EnvSpecDiagnosticsCore {

    private val DECORATOR_LINE_PATTERN = Regex("""^\s*#\s*(@.*)$""")
    private val DECORATOR_PATTERN = Regex("@([A-Za-z][\\w-]*)(?:\\([^)]*\\)|=[^\\s#]+)?")
    private val NON_DECORATOR_LABEL_RE = Regex("^@[A-Za-z]+:")
    private val NON_DECORATOR_PROSE_RE = Regex("^@[A-Za-z]+\\s+[^@#]")
    private const val MAX_MATCHES_PATTERN_LENGTH = 200
    private val INCOMPATIBLE_DECORATOR_PAIRS = listOf(
        listOf("required", "optional"),
        listOf("sensitive", "public"),
    )

    data class TypeInfo(val name: String, val args: List<String>, val options: Map<String, Any>)
    data class DecoratorOccurrence(val name: String, val line: Int, val start: Int, val end: Int)
    data class CoreDiagnostic(val line: Int, val start: Int, val end: Int, val message: String)

    fun getDecoratorCommentText(lineText: String): String? {
        return getDecoratorCommentRange(lineText)?.first
    }

    private fun getDecoratorCommentRange(lineText: String): Pair<String, Int>? {
        val match = DECORATOR_LINE_PATTERN.find(lineText) ?: return null
        val commentText = match.groupValues[1]
        if (NON_DECORATOR_LABEL_RE.containsMatchIn(commentText)) return null
        if (NON_DECORATOR_PROSE_RE.containsMatchIn(commentText)) return null
        val stripped = stripInlineComment(commentText)
        val startIndex = match.groups[1]!!.range.first
        return stripped to startIndex
    }

    fun stripInlineComment(value: String): String {
        var quote: Char? = null
        for (i in value.indices) {
            val char = value[i]
            when {
                quote != null -> {
                    if (char == quote) quote = null
                }
                char == '"' || char == '\'' -> quote = char
                char == '#' && (i == 0 || value[i - 1].isWhitespace()) ->
                    return value.substring(0, i).trimEnd()
                else -> {}
            }
        }
        return value.trim()
    }

    fun unquote(value: String): String {
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith('\'') && value.endsWith('\''))) {
            return value.substring(1, value.length - 1)
        }
        return value
    }

    fun isDynamicValue(value: String): Boolean =
        Regex("\\\$[A-Za-z_]").containsMatchIn(value) || Regex("^[A-Za-z][\\w-]*\\(").containsMatchIn(value)

    private fun splitCommaSeparatedArgs(input: String): List<String> {
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
                char == '"' || char == '\'' -> { quote = char; current += char }
                char == '(' -> { depth++; current += char }
                char == ')' -> { depth = maxOf(depth - 1, 0); current += char }
                char == ',' && depth == 0 -> {
                    val v = current.trim()
                    if (v.isNotEmpty()) parts.add(v)
                    current = ""
                }
                else -> current += char
            }
        }
        val v = current.trim()
        if (v.isNotEmpty()) parts.add(v)
        return parts
    }

    fun splitEnumArgs(input: String): List<String> =
        splitCommaSeparatedArgs(input).map { unquote(it).trim() }.filter { it.isNotEmpty() }

    private fun parseBooleanOption(value: Any?): Boolean? {
        when (value) {
            true -> return true
            false -> return false
            "true" -> return true
            "false" -> return false
        }
        return null
    }

    private fun parseTypeOptions(input: String): Map<String, String> {
        return splitCommaSeparatedArgs(input).mapNotNull { part ->
            val sep = part.indexOf('=')
            if (sep < 0) return@mapNotNull null
            val key = part.substring(0, sep).trim()
            val rawValue = part.substring(sep + 1).trim()
            if (key.isEmpty()) return@mapNotNull null
            key to unquote(rawValue)
        }.toMap()
    }

    fun getPrecedingCommentBlock(document: LineDocument, lineNumber: Int): List<String> {
        val lines = mutableListOf<String>()
        for (line in lineNumber - 1 downTo 0) {
            val text = document.lineAt(line).text.trim()
            if (!text.startsWith("#")) break
            lines.add(0, text)
        }
        return lines
    }

    fun getTypeInfoFromPrecedingComments(document: LineDocument, lineNumber: Int): TypeInfo? {
        val commentBlock = getPrecedingCommentBlock(document, lineNumber)
        for (index in commentBlock.indices.reversed()) {
            val decoratorText = getDecoratorCommentText(commentBlock[index]) ?: continue
            val match = Regex("@type=([A-Za-z][\\w-]*)(?:\\((.*)\\))?").find(decoratorText) ?: continue
            return if (match.groupValues[1] == "enum") {
                TypeInfo("enum", splitEnumArgs(match.groupValues[2]), emptyMap())
            } else {
                TypeInfo(match.groupValues[1], emptyList(), parseTypeOptions(match.groupValues[2]))
            }
        }
        return null
    }

    fun getDecoratorOccurrences(lineText: String, lineNumber: Int): List<DecoratorOccurrence> {
        val (decoratorText, startIndex) = getDecoratorCommentRange(lineText) ?: return emptyList()
        return DECORATOR_PATTERN.findAll(decoratorText).map { match ->
            val absStart = startIndex + (match.range.first)
            DecoratorOccurrence(match.groupValues[1], lineNumber, absStart, absStart + match.value.length)
        }.toList()
    }

    fun createDecoratorDiagnostics(occurrences: List<DecoratorOccurrence>): List<CoreDiagnostic> {
        val diagnostics = mutableListOf<CoreDiagnostic>()
        val seenCounts = mutableMapOf<String, Int>()
        val reportedRanges = mutableSetOf<String>()
        for (occ in occurrences) {
            val count = seenCounts.getOrDefault(occ.name, 0)
            seenCounts[occ.name] = count + 1
            val decorator = EnvSpecCatalog.DECORATORS_BY_NAME[occ.name]
            if (decorator?.isFunction != true && count >= 1) {
                diagnostics.add(CoreDiagnostic(occ.line, occ.start, occ.end,
                    "@${occ.name} can only be used once in the same decorator block."))
            }
        }
        for ((left, right) in INCOMPATIBLE_DECORATOR_PAIRS) {
            val conflicting = occurrences.filter { it.name == left || it.name == right }
            if (!conflicting.any { it.name == left } || !conflicting.any { it.name == right }) continue
            for (occ in conflicting) {
                val key = "${occ.line}:${occ.start}:${occ.end}"
                if (key in reportedRanges) continue
                reportedRanges.add(key)
                diagnostics.add(CoreDiagnostic(occ.line, occ.start, occ.end,
                    "@$left and @$right cannot be used together."))
            }
        }
        return diagnostics
    }

    private fun validateStringValue(value: String, options: Map<String, Any>): String? {
        val allowEmpty = parseBooleanOption(options["allowEmpty"])
        if (allowEmpty != true && value.isEmpty()) return "Value cannot be empty."
        (options["minLength"] as? String)?.let { if (value.length < it.toInt()) return "Value must be at least $it characters long." }
        (options["maxLength"] as? String)?.let { if (value.length > it.toInt()) return "Value must be at most $it characters long." }
        (options["isLength"] as? String)?.let { if (value.length != it.toInt()) return "Value must be exactly $it characters long." }
        (options["startsWith"] as? String)?.let { if (!value.startsWith(it)) return "Value must start with `$it`." }
        (options["endsWith"] as? String)?.let { if (!value.endsWith(it)) return "Value must end with `$it`." }
        (options["matches"] as? String)?.let { m ->
            if (m.length > MAX_MATCHES_PATTERN_LENGTH) return@let
            try {
                if (!Regex(m).containsMatchIn(value)) return "Value must match `$m`."
            } catch (_: Exception) {}
        }
        return null
    }

    private fun validateNumberValue(value: String, options: Map<String, Any>): String? {
        val n = value.toDoubleOrNull() ?: return "Value must be a valid number."
        if (!n.isFinite()) return "Value must be a valid number."
        (options["min"] as? String)?.let { if (n < it.toDouble()) return "Value must be greater than or equal to $it." }
        (options["max"] as? String)?.let { if (n > it.toDouble()) return "Value must be less than or equal to $it." }
        if (options["isInt"] == "true" || options["isInt"] == true) {
            if (value.toDoubleOrNull()?.let { it != it.toInt().toDouble() } == true) return "Value must be an integer."
        }
        (options["isDivisibleBy"] as? String)?.let {
            if (n % it.toDouble() != 0.0) return "Value must be divisible by $it."
        }
        (options["precision"] as? String)?.let {
            val decimals = value.substringAfter('.', "")
            if (decimals.length > it.toInt()) return "Value must have at most $it decimal places."
        }
        return null
    }

    private fun validateUrlValue(value: String, options: Map<String, Any>): String? {
        val prependHttps = parseBooleanOption(options["prependHttps"])
        val hasProtocol = Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(value)
        if (prependHttps == true && hasProtocol) return "URL should omit the protocol when prependHttps=true."
        if (prependHttps != true && !hasProtocol) return "URL must include a protocol unless prependHttps=true."
        return try {
            val spec = if (prependHttps == true) "https://$value" else value
            val url = URI.create(spec).toURL()
            val allowedDomains = (options["allowedDomains"] as? String)?.let { splitEnumArgs(it) } ?: emptyList()
            if (allowedDomains.isNotEmpty() && !allowedDomains.contains(url.host.lowercase())) {
                "URL host must be one of: ${allowedDomains.joinToString(", ")}."
            } else null
        } catch (_: Exception) {
            "Value must be a valid URL."
        }
    }

    private fun isIP(value: String): Int? {
        return try {
            val addr = InetAddress.getByName(value)
            when (addr) {
                is java.net.Inet4Address -> 4
                is java.net.Inet6Address -> 6
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    fun validateStaticValue(typeInfo: TypeInfo, value: String): String? {
        return when (typeInfo.name) {
            "string" -> validateStringValue(value, typeInfo.options)
            "number" -> validateNumberValue(value, typeInfo.options)
            "boolean" -> if (Regex("^(true|false|1|0|yes|no|on|off)$", RegexOption.IGNORE_CASE).matches(value)) null else "Value must be a boolean."
            "email" -> if (Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$").matches(value)) null else "Value must be a valid email address."
            "url" -> validateUrlValue(value, typeInfo.options)
            "ip" -> {
                val version = (typeInfo.options["version"] as? String)?.toIntOrNull() ?: 0
                val detected = isIP(value)
                when {
                    detected == null -> "Value must be a valid IPv4 or IPv6 address."
                    (version == 4 || version == 6) && detected != version -> "Value must be a valid IPv$version address."
                    else -> null
                }
            }
            "port" -> {
                val n = value.toIntOrNull() ?: -1
                if (n !in 0..65535) return "Value must be a valid port number."
                (typeInfo.options["min"] as? String)?.let { if (n < it.toInt()) return "Port must be greater than or equal to $it." }
                (typeInfo.options["max"] as? String)?.let { if (n > it.toInt()) return "Port must be less than or equal to $it." }
                null
            }
            "semver" -> if (Regex("^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$").matches(value)) null else "Value must be a valid semantic version."
            "isoDate" -> if (Regex("^\\d{4}-\\d{2}-\\d{2}(?:[T ][0-9:.+-Z]*)?$").matches(value)) {
                try {
                    java.time.LocalDate.parse(value.substring(0, 10))
                    null
                } catch (_: Exception) { "Value must be a valid ISO date." }
            } else "Value must be a valid ISO date."
            "uuid" -> if (Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE).matches(value)) null else "Value must be a valid UUID."
            "md5" -> if (Regex("^[0-9a-f]{32}$", RegexOption.IGNORE_CASE).matches(value)) null else "Value must be a valid MD5 hash."
            "enum" -> if (value in typeInfo.args) null else "Value must be one of: ${typeInfo.args.joinToString(", ")}."
            else -> null
        }
    }
}
