/**
 * Constants shared across the local-encrypt modules.
 *
 * Kept in a leaf module so backends and the daemon client can use them without
 * importing `./index`, which imports them in turn.
 */

/**
 * Key id used when a caller does not name one. Must stay in sync with the
 * native helper binaries, which apply the same default.
 */
export const DEFAULT_KEY_ID = 'varlock-default';
