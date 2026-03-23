package dev.dmno.envspec

import com.intellij.openapi.fileTypes.LanguageFileType
import com.intellij.openapi.util.IconLoader
import javax.swing.Icon

class EnvSpecFileType private constructor() : LanguageFileType(EnvSpecLanguage) {

    override fun getName(): String = "EnvSpec"
    override fun getDescription(): String = "@env-spec (.env) file"
    override fun getDefaultExtension(): String = "env"
    override fun getIcon(): Icon = ICON

    companion object {
        @JvmField
        val ICON: Icon = IconLoader.getIcon("/icons/env-spec.svg", EnvSpecFileType::class.java)

        @JvmStatic
        val INSTANCE = EnvSpecFileType()
    }
}
