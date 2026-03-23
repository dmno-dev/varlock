package dev.dmno.envspec

import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class EnvSpecCompletionContributorTest {

    private fun invokePrivateMatch(
        contributor: EnvSpecCompletionContributor,
        methodName: String,
        text: String,
    ): Any? {
        val method = EnvSpecCompletionContributor::class.java.getDeclaredMethod(
            methodName,
            String::class.java,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
        )
        method.isAccessible = true
        return method.invoke(contributor, text, 0, text.length, 0)
    }

    @Test
    fun matchesDecoratorValueEvenWhenNothingTypedAfterEquals() {
        val contributor = EnvSpecCompletionContributor()
        val match = invokePrivateMatch(contributor, "matchDecoratorValue", "@required=")
        assertNotNull(match)
    }

    @Test
    fun matchesResolverValueEvenWhenNothingTypedAfterEquals() {
        val contributor = EnvSpecCompletionContributor()
        val match = invokePrivateMatch(contributor, "matchResolverValue", "API_URL=")
        assertNotNull(match)
    }

    @Test
    fun normalizesSnippetInsertTextForIntellij() {
        val contributor = EnvSpecCompletionContributor()
        val method = EnvSpecCompletionContributor::class.java.getDeclaredMethod(
            "normalizeSnippetInsertText",
            String::class.java,
        )
        method.isAccessible = true

        val normalized = method.invoke(contributor, """matches=${'$'}{1:"^[A-Z0-9_]+${'$'}"}""") as String
        assertEquals("""matches="^[A-Z0-9_]+$"""", normalized)

        val choiceNormalized = method.invoke(
            contributor,
            """@defaultRequired=${'$'}{1|infer,true,false|}""",
        ) as String
        assertEquals("@defaultRequired=infer", choiceNormalized)

        val tabstopNormalized = method.invoke(
            contributor,
            """value=${'$'}{1}""",
        ) as String
        assertEquals("value=", tabstopNormalized)

        val kotlinEscaped = method.invoke(
            contributor,
            """matches=\${'$'}{1:"^[A-Z0-9_]+\${'$'}"}""",
        ) as String
        assertTrue(kotlinEscaped.startsWith("matches="))
        assertTrue(!kotlinEscaped.contains("\${"))
    }
}
