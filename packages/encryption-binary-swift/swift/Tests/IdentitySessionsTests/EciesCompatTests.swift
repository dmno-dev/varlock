import XCTest
import CryptoKit
@testable import IdentitySessions

/// Proves the Swift software ECIES path reads exactly what the TypeScript
/// implementation writes.
///
/// The fixture is produced by `packages/encryption-binary-swift/scripts/generate-ecies-fixture.ts`
/// using `packages/varlock/src/lib/local-encrypt/crypto.ts`, then checked in. A failure
/// here means the two implementations have drifted, so regenerate the fixture only when
/// the wire format changed on purpose.
final class EciesCompatTests: XCTestCase {

    private struct Vector: Decodable {
        let version: UInt8
        let publicKey: String
        let privateKeyPkcs8: String
        let plaintext: String
        let payload: String
    }

    private struct Fixture: Decodable {
        let identity: Vector
        let device: Vector
    }

    private func loadFixture() throws -> Fixture {
        guard let url = Bundle.module.url(forResource: "ecies-vector", withExtension: "json", subdirectory: "fixtures") else {
            XCTFail("missing ecies-vector.json fixture")
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(Fixture.self, from: try Data(contentsOf: url))
    }

    private func privateKey(_ vector: Vector) throws -> P256.KeyAgreement.PrivateKey {
        let der = try XCTUnwrap(Data(base64Encoded: vector.privateKeyPkcs8))
        return try IdentityKeyImport.p256KeyAgreementKey(fromPkcs8: der)
    }

    // MARK: - Reading what TypeScript wrote

    func testDecryptsIdentityPayloadWrittenByTypeScript() throws {
        let fixture = try loadFixture()
        let payload = try XCTUnwrap(Data(base64Encoded: fixture.identity.payload))
        XCTAssertEqual(payload.first, Ecies.identityPayloadVersion)

        let decrypted = try Ecies.decrypt(
            payload: payload,
            using: try privateKey(fixture.identity),
            acceptedVersions: [Ecies.identityPayloadVersion]
        )
        XCTAssertEqual(String(data: decrypted, encoding: .utf8), fixture.identity.plaintext)
    }

    func testDecryptsDevicePayloadWrittenByTypeScript() throws {
        let fixture = try loadFixture()
        let payload = try XCTUnwrap(Data(base64Encoded: fixture.device.payload))
        XCTAssertEqual(payload.first, Ecies.devicePayloadVersion)

        let decrypted = try Ecies.decrypt(
            payload: payload,
            using: try privateKey(fixture.device),
            acceptedVersions: [Ecies.devicePayloadVersion]
        )
        XCTAssertEqual(String(data: decrypted, encoding: .utf8), fixture.device.plaintext)
    }

    /// The PKCS#8 in the fixture must yield the same public key the fixture names,
    /// which is what makes the HKDF `info` binding line up across implementations.
    func testImportedPrivateKeyMatchesFixturePublicKey() throws {
        let fixture = try loadFixture()
        let key = try privateKey(fixture.identity)
        XCTAssertEqual(key.publicKeyX963.base64EncodedString(), fixture.identity.publicKey)
    }

    // MARK: - Writing what TypeScript can read

    /// Swift-side encryption of the prompt-secret path, verified by decrypting with
    /// the fixture's key. The TS half of this direction is covered by the fixture's
    /// own round trip in the generator script.
    func testSwiftEncryptionRoundTripsAgainstFixtureKey() throws {
        let fixture = try loadFixture()
        let recipient = try XCTUnwrap(Data(base64Encoded: fixture.identity.publicKey))
        let secret = "value captured in the daemon, never crossing the socket in the clear"

        let payload = try Ecies.encrypt(
            plaintext: Data(secret.utf8),
            toPublicKeyData: recipient,
            version: Ecies.identityPayloadVersion
        )
        XCTAssertEqual(payload.first, Ecies.identityPayloadVersion)

        let decrypted = try Ecies.decrypt(
            payload: payload,
            using: try privateKey(fixture.identity),
            acceptedVersions: [Ecies.identityPayloadVersion]
        )
        XCTAssertEqual(String(data: decrypted, encoding: .utf8), secret)
    }

    // MARK: - Framing

    func testRejectsUnexpectedVersionByte() throws {
        let fixture = try loadFixture()
        var payload = try XCTUnwrap(Data(base64Encoded: fixture.identity.payload))
        payload[0] = 0x09

        XCTAssertThrowsError(try Ecies.decrypt(
            payload: payload,
            using: try privateKey(fixture.identity),
            acceptedVersions: [Ecies.identityPayloadVersion]
        ))
    }

    func testRejectsTamperedCiphertext() throws {
        let fixture = try loadFixture()
        var payload = try XCTUnwrap(Data(base64Encoded: fixture.identity.payload))
        payload[payload.count - 20] ^= 0xff

        XCTAssertThrowsError(try Ecies.decrypt(
            payload: payload,
            using: try privateKey(fixture.identity),
            acceptedVersions: [Ecies.identityPayloadVersion]
        ))
    }

    func testRejectsTruncatedPayload() throws {
        XCTAssertThrowsError(try Ecies.parse(payload: Data(repeating: 0, count: 40)))
    }

    // MARK: - HKDF

    /// RFC 5869 test case 1, so a refactor of the derivation cannot quietly change
    /// what both implementations agree on.
    func testHkdfMatchesRfc5869TestCase1() {
        let ikm = Data(repeating: 0x0b, count: 22)
        let salt = Data((0x00...0x0c).map { UInt8($0) })
        let info = Data((0xf0...0xf9).map { UInt8($0) })
        let okm = Ecies.deriveKey(sharedSecret: ikm, salt: salt, info: info, outputByteCount: 42)
        let hex = okm.withUnsafeBytes { Data($0) }.map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(
            hex,
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        )
    }
}
