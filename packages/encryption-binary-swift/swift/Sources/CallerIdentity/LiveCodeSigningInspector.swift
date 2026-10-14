import Foundation
import Darwin
import Security

/// Kernel code-signing status bit: the process's signature is currently valid
private let CS_VALID: UInt32 = 0x1
/// CodeDirectory flag bits (see `codesign -dv` "flags=")
private let CS_ADHOC: UInt32 = 0x2
private let CS_RUNTIME: UInt32 = 0x10000

/// `CodeSigningInspector` backed by the Security framework.
public final class LiveCodeSigningInspector: CodeSigningInspector {
    // Requirements are checked strongest first; the first match decides the kind
    private static let requirementsByKind: [(SignatureKind, String)] = [
        (.applePlatform, "anchor apple"),
        // Developer ID Application: Apple's intermediate CA marker + leaf marker
        (.developerId, "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"),
        (.appleIssued, "anchor apple generic"),
    ]

    private let requirements: [(SignatureKind, SecRequirement)]

    public init() {
        requirements = Self.requirementsByKind.compactMap { kind, text in
            var req: SecRequirement?
            guard SecRequirementCreateWithString(text as CFString, [], &req) == errSecSuccess, let req else { return nil }
            return (kind, req)
        }
    }

    public func signingInfo(auditToken: audit_token_t) -> CodeSigningInfo? {
        var token = auditToken
        let tokenData = Data(bytes: &token, count: MemoryLayout<audit_token_t>.size)
        return signingInfo(guestAttributes: [kSecGuestAttributeAudit: tokenData])
    }

    public func signingInfo(pid: pid_t) -> CodeSigningInfo? {
        return signingInfo(guestAttributes: [kSecGuestAttributePid: NSNumber(value: pid)])
    }

    private func signingInfo(guestAttributes: [CFString: Any]) -> CodeSigningInfo? {
        var codeRef: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, guestAttributes as CFDictionary, [], &codeRef) == errSecSuccess,
              let code = codeRef else { return nil }
        return classify(code)
    }

    private func classify(_ code: SecCode) -> CodeSigningInfo {
        // A SecCode is accepted wherever a SecStaticCode is, and passing the
        // dynamic object is what makes kSecCSDynamicInformation (live kernel
        // status) available
        let asStatic = unsafeBitCast(code, to: SecStaticCode.self)
        var infoRef: CFDictionary?
        let flags = SecCSFlags(rawValue: kSecCSSigningInformation | kSecCSDynamicInformation)
        guard SecCodeCopySigningInformation(asStatic, flags, &infoRef) == errSecSuccess,
              let info = infoRef as? [String: Any] else {
            return CodeSigningInfo(kind: .invalid, identifier: nil, teamId: nil, signerName: nil, hardenedRuntime: false)
        }

        let identifier = info[kSecCodeInfoIdentifier as String] as? String
        let teamId = info[kSecCodeInfoTeamIdentifier as String] as? String
        let cdFlags = (info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
        let status = (info[kSecCodeInfoStatus as String] as? NSNumber)?.uint32Value ?? 0
        let hardenedRuntime = cdFlags & CS_RUNTIME != 0
        var signerName: String?
        if let certs = info[kSecCodeInfoCertificates as String] as? [SecCertificate], let leaf = certs.first {
            signerName = SecCertificateCopySubjectSummary(leaf) as String?
        }

        func result(_ kind: SignatureKind) -> CodeSigningInfo {
            CodeSigningInfo(kind: kind, identifier: identifier, teamId: teamId, signerName: signerName, hardenedRuntime: hardenedRuntime)
        }

        // no identifier means there is no signature at all
        guard identifier != nil else { return result(.unsigned) }
        // the kernel already validates every page as it is mapped; if it has
        // flagged the process invalid, nothing else about the signature counts
        guard status & CS_VALID != 0 else { return result(.invalid) }
        if cdFlags & CS_ADHOC != 0 { return result(.adHoc) }

        // Check the requirement against the running code, not the file at its
        // path, which could have been replaced since launch. This is cheap
        // (~10ms for node): the kernel has already validated the pages.
        for (kind, req) in requirements where SecCodeCheckValidity(code, [], req) == errSecSuccess {
            return result(kind)
        }
        return result(.untrustedCertificate)
    }
}
