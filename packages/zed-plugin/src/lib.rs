use std::{env, fs};
use zed_extension_api::{
    self as zed, DownloadedFileType, LanguageServerId, LanguageServerInstallationStatus, Result,
};

/// GitHub repo that hosts the bundled language-server release asset.
const GITHUB_REPO: &str = "dmno-dev/varlock";
/// Release tag that contains the bundled language-server asset for this extension version.
const RELEASE_TAG: &str = "v0.1.3";
/// Name of the release asset (a single, dependency-free CJS bundle).
const ASSET_NAME: &str = "env-spec-language-server.js";
/// Local development build, used when this folder is installed as a dev extension.
const LOCAL_SERVER_PATH: &str = "server/out/server.js";

struct EnvSpecExtension {
    cached_server_path: Option<String>,
}

impl EnvSpecExtension {
    fn server_script_path(&mut self, language_server_id: &LanguageServerId) -> Result<String> {
        if fs::metadata(LOCAL_SERVER_PATH).map_or(false, |stat| stat.is_file()) {
            return Ok(LOCAL_SERVER_PATH.to_string());
        }

        if let Some(path) = &self.cached_server_path {
            if fs::metadata(path).map_or(false, |stat| stat.is_file()) {
                return Ok(path.clone());
            }
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::CheckingForUpdate,
        );

        let release = zed::github_release_by_tag_name(GITHUB_REPO, RELEASE_TAG)?;

        let asset = release
            .assets
            .iter()
            .find(|asset| asset.name == ASSET_NAME)
            .ok_or_else(|| {
                format!(
                    "release '{}' for {GITHUB_REPO} has no asset named '{ASSET_NAME}'",
                    release.version
                )
            })?;

        let version_dir = format!("env-spec-language-server-{}", release.version);
        let server_path = format!("{version_dir}/server.js");

        if !fs::metadata(&server_path).map_or(false, |stat| stat.is_file()) {
            zed::set_language_server_installation_status(
                language_server_id,
                &LanguageServerInstallationStatus::Downloading,
            );

            fs::create_dir_all(&version_dir)
                .map_err(|err| format!("failed to create directory '{version_dir}': {err}"))?;

            zed::download_file(
                &asset.download_url,
                &server_path,
                DownloadedFileType::Uncompressed,
            )
            .map_err(|err| format!("failed to download {ASSET_NAME}: {err}"))?;

            if !fs::metadata(&server_path).map_or(false, |stat| stat.is_file()) {
                return Err(format!(
                    "downloaded asset '{ASSET_NAME}' but '{server_path}' is missing"
                ));
            }

            // Prune older versioned server directories.
            if let Ok(entries) = fs::read_dir(".") {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with("env-spec-language-server-")
                        && name.as_ref() != version_dir.as_str()
                    {
                        fs::remove_dir_all(entry.path()).ok();
                    }
                }
            }
        }

        self.cached_server_path = Some(server_path.clone());
        Ok(server_path)
    }
}

impl zed::Extension for EnvSpecExtension {
    fn new() -> Self {
        Self {
            cached_server_path: None,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let server_path = self.server_script_path(language_server_id)?;
        let absolute_server_path = env::current_dir()
            .map_err(|err| format!("failed to resolve extension working dir: {err}"))?
            .join(&server_path)
            .to_string_lossy()
            .to_string();

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![absolute_server_path, "--stdio".to_string()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(EnvSpecExtension);
