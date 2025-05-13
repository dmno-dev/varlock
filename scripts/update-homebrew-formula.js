import fs from 'node:fs/promises';

function generateVarlockFormula(version, checksums) {
  return `
class Varlock < Formula
  desc "varlock is a tool to load and validate .env files"
  homepage "https://varlock.dev"
  version "${version}"

  on_macos do
    on_intel do
      url "https://github.com/dmno-dev/varlock/releases/download/varlock@${version}/varlock-${version}-macos-x64.tar.gz"
      sha256 "${checksums['macos-x64']}"
    end

    on_arm do
      url "https://github.com/dmno-dev/varlock/releases/download/varlock@${version}/varlock-${version}-macos-arm64.tar.gz"
      sha256 "${checksums['macos-arm64']}"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/dmno-dev/varlock/releases/download/varlock@${version}/varlock-${version}-linux-x64.tar.gz"
      sha256 "${checksums['linux-x64']}"
    end

    on_arm do
      url "https://github.com/dmno-dev/varlock/releases/download/varlock@${version}/varlock-${version}-linux-arm64.tar.gz"
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
}

// download checksums file from release
const checksumsReq = await fetch(`https://github.com/dmno-dev/varlock/releases/download/varlock@${version}/checksums.txt`);
const checksumsStr = await checksumsReq.text();
const checksums = {};
checksumsStr.split('\n').forEach((line) => {
  const [sha256, fileName] = line.split('  ');
  const fileNameParts = fileName.split('-');
  const platform = fileNameParts[2];
  const arch = fileNameParts[3];
  checksums[`${platform}-${arch}`] = sha256;
});

const args = process.argv.slice(2);
const version = args[0];

const formulaStr = generateVarlockFormula(version, checksums);

// this is meant to be used in a github action
// when we have checked out the homebrew-tap repo
await fs.writeFile('homebrew-tap/Formula/varlock.rb', formulaStr, 'utf-8');
