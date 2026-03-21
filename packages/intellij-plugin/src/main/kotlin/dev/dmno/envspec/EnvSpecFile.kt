package dev.dmno.envspec

import com.intellij.extapi.psi.PsiFileBase
import com.intellij.openapi.fileTypes.FileType
import com.intellij.psi.FileViewProvider

class EnvSpecFile(viewProvider: FileViewProvider) : PsiFileBase(viewProvider, EnvSpecLanguage) {

    override fun getFileType(): FileType = EnvSpecFileType.INSTANCE
}
