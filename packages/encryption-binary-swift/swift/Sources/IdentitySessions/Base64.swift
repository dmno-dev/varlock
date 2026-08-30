import Foundation

/// Base64 that never routes key material through a Swift `String`.
///
/// `Data(base64Encoded:)` takes a String, and String storage is copied and
/// reference counted with no way to scrub it. Unwrapped identity keys arrive as
/// base64 bytes, so they get decoded here instead, straight from Data to Data.
public enum RawBase64 {
    private static let decodeTable: [Int8] = {
        var table = [Int8](repeating: -1, count: 256)
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".utf8)
        for (index, char) in alphabet.enumerated() {
            table[Int(char)] = Int8(index)
        }
        return table
    }()

    public enum Base64Error: LocalizedError {
        case invalidCharacter
        case invalidLength

        public var errorDescription: String? {
            switch self {
            case .invalidCharacter: return "Invalid base64 input"
            case .invalidLength: return "Invalid base64 length"
            }
        }
    }

    /// Decode base64 bytes. Whitespace and `=` padding are skipped.
    public static func decode(_ input: Data) throws -> Data {
        var out = Data()
        out.reserveCapacity((input.count / 4) * 3)

        var accumulator: UInt32 = 0
        var bitsCollected = 0

        for byte in input {
            if byte == UInt8(ascii: "=") { continue }
            if byte == 0x0a || byte == 0x0d || byte == 0x20 || byte == 0x09 { continue }
            let decoded = decodeTable[Int(byte)]
            guard decoded >= 0 else { throw Base64Error.invalidCharacter }

            accumulator = (accumulator << 6) | UInt32(UInt8(decoded))
            bitsCollected += 6
            if bitsCollected >= 8 {
                bitsCollected -= 8
                out.append(UInt8((accumulator >> UInt32(bitsCollected)) & 0xff))
            }
        }

        // Leftover bits must be padding zeroes, never a partial byte of data
        guard bitsCollected < 6 else { throw Base64Error.invalidLength }
        return out
    }
}
