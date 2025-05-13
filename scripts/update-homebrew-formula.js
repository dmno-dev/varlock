import fs from 'node:fs/promises';

// this is run in a Github Action where this env var is set
const VERSION = process.env.RELEASE_VERSION;

// download checksums file from release
const checksumsReq = await fetch(`https://github.com/dmno-dev/varlock/releases/download/varlock@${VERSION}/checksums.txt`);
const checksumsStr = await checksumsReq.text();
const checksums = {};
checksumsStr.split('\n').forEach((line) => {
  const [sha256, fileName] = line.split('  ');
  const fileNameParts = fileName.split('-');
  const platform = fileNameParts[2];
  const arch = fileNameParts[3];
  checksums[`${platform}-${arch}`] = sha256;
});



const formulaSrc = `
class Varlock < Formula
  desc "varlock is a tool to load and validate .env files"
  homepage "https://varlock.dev"
  version "${VERSION}"

  on_macos do
    on_intel do
      url "https://github.com/dmno-dev/varlock/releases/download/varlock@#{version}/varlock-#{version}-macos-x64.tar.gz"
      sha256 "${checksums['macos-x64']}"
    end

    on_arm do
      url "https://github.com/dmno-dev/varlock/releases/download/varlock@#{version}/varlock-#{version}-macos-arm64.tar.gz"
      sha256 "${checksums['macos-arm64']}"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/dmno-dev/varlock/releases/download/varlock@#{version}/varlock-#{version}-linux-x64.tar.gz"
      sha256 "${checksums['linux-x64']}"
    end

    on_arm do
      url "https://github.com/dmno-dev/varlock/releases/download/varlock@#{version}/varlock-#{version}-linux-arm64.tar.gz"
      sha256 "${checksums['linux-arm64']}"
    end
  end

  def install
    bin.install "varlock"
  end

  test do
    system bin/"varlock", "--version"
  end
end
`;


// this is meant to be used in a github action
// when we have checked out the homebrew-tap repo
await fs.writeFile('homebrew-tap/Formula/varlock.rb', formulaSrc, 'utf-8');
