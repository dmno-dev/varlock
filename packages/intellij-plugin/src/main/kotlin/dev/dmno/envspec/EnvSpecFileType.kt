package dev.dmno.envspec

import com.intellij.lang.Language
import com.intellij.openapi.fileTypes.LanguageFileType
import javax.swing.Icon

class EnvSpecFileType private constructor() : LanguageFileType(EnvSpecLanguage) {

    override fun getName(): String = "EnvSpec"
    override fun getDescription(): String = "@env-spec (.env) file"
    override fun getDefaultExtension(): String = "env"
    override fun getIcon(): Icon? = null

    companion object {
        @JvmStatic
        val INSTANCE = EnvSpecFileType()
    }
}
