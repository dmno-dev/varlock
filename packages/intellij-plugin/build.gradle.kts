plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.13.1"
}

group = "dev.dmno"
version = "0.1.2"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdea("2024.3.6")
    }
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.0")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testRuntimeOnly("junit:junit:4.13.2")  // IntelliJ test framework needs JUnit4 classes (IJPL-159134)
}

tasks.test {
    useJUnitPlatform()
}

tasks.named<JavaExec>("runIde") {
    // Open the varlock repository root when the sandbox IDE starts.
    val repoRoot = layout.projectDirectory.dir("../..").asFile.absolutePath
    args(repoRoot)
}

// Ensure `build` produces the plugin zip (buildPlugin is not included by default)
tasks.named("build") {
    dependsOn(tasks.named("buildPlugin"))
}

intellijPlatform {
    buildSearchableOptions.set(false)
    pluginConfiguration {
        name.set("Env Spec Language")
        description.set("Adds syntax highlighting and IntelliSense for @env-spec enabled .env files")
        ideaVersion {
            // 243 = 2024.3 platform line. Keep this explicit so Marketplace compatibility is predictable.
            sinceBuild.set("243")
            // Allow current and near-future IDE lines; tighten if verifier starts flagging breakage.
            untilBuild.set("251.*")
        }
        vendor {
            name.set("dmno-dev")
            url.set("https://varlock.dev")
        }
    }
    pluginVerification {
        ides {
            recommended()
        }
    }
    signing {
        certificateChain.set(providers.environmentVariable("JETBRAINS_CERTIFICATE_CHAIN"))
        privateKey.set(providers.environmentVariable("JETBRAINS_PRIVATE_KEY"))
        password.set(providers.environmentVariable("JETBRAINS_PRIVATE_KEY_PASSWORD"))
    }
    publishing {
        token.set(providers.environmentVariable("JETBRAINS_MARKETPLACE_TOKEN"))
    }
}

kotlin {
    jvmToolchain(17)
}
