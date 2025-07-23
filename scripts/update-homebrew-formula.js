import fs from 'node:fs/promises';
import path from 'node:path';
// this is run in a Github Action where this env var is set
const VERSION = process.env.RELEASE_VERSION;

// get checksums file from dist-sea since we are running this script just after building the binaries
const checksumsStr = await fs.readFile(path.join(import.meta.dirname, '../packages/varlock/dist-sea/checksums.txt'), 'utf-8');
const checksums = {};
checksumsStr.split('\n').forEach((line) => {
  if (!line.trim()) return; // skip trailing blank line
  const [sha256, fileName] = line.split('  ');
  const fileNameParts = fileName.replace(/(\.tar\.gz|\.zip)$/, '').split('-');
  const platform = fileNameParts[1];
  const arch = fileNameParts[2];
  checksums[`${platform}-${arch}`] = sha256;
});

const formulaSrc = `
class Varlock < Formula
  desc "varlock is a tool to load and validate .env files"
  homepage "https://varlock.dev"
  # ! the version number in this file is fetched and used by our install.sh script
  version "${VERSION}"

  on_macos do
    on_intel do
      url "https://github.com/dmno-dev/varlock/releases/download/varlock@#{version}/varlock-macos-x64.tar.gz"
      sha256 "${checksums['macos-x64']}"
    end

    on_arm do
      url "https://github.com/dmno-dev/varlock/releases/download/varlock@#{version}/varlock-macos-arm64.tar.gz"
      sha256 "${checksums['macos-arm64']}"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/dmno-dev/varlock/releases/download/varlock@#{version}/varlock-linux-x64.tar.gz"
      sha256 "${checksums['linux-x64']}"
    end

    on_arm do
      url "https://github.com/dmno-dev/varlock/releases/download/varlock@#{version}/varlock-linux-arm64.tar.gz"
      sha256 "${checksums['linux-arm64']}"
    end
  end

  def install
    bin.install "varlock"
  end

  test do
    assert_equal "${VERSION}", shell_output("#{bin}/varlock --post-install brew").strip
  end
end
`;

// this is meant to be used in a github action
// when we have checked out the homebrew-tap repo
await fs.writeFile('homebrew-tap/Formula/varlock.rb', formulaSrc, 'utf-8');
