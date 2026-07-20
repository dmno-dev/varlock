import { createHash } from 'node:crypto';
import _ from '@env-spec/utils/my-dash';
import { type FallbackIfUnknown } from '@env-spec/utils/type-utils';
import { CoercionError, ValidationError } from './errors';
import { parseRegexLikeString } from './resolver';
import {
  parseDuration, convertDurationFromMs, type DurationUnit,
} from '../../lib/duration';

type MaybePromise<T> = T | Promise<T>;

/**
 * The runtime shape a data type's `coerce()` produces — consumed by code generation to type the
 * generated fields in each target language. `'int'` vs `'number'` matters for languages that
 * distinguish them (Go/Rust/PHP; JS/TS just uses `number`); an enum carries its member values so
 * emitters can build literal-union types. Types that don't declare one are treated as strings.
 */
export type CoercedType = | 'string'
  | 'int' // integer number
  | 'number' // general (possibly fractional) number
  | 'boolean'
  | 'object' // free-form object (no per-value typing)
  | { enum: Array<string | number | boolean> }
  | { arrayOf: CoercedType } // typed array (e.g. `array(email)` → { arrayOf: 'string' })
  // typed record - `values` is the per-value type, `keys` restricts keys (e.g. an enum);
  // either may be absent when that side is unconstrained
  | { recordOf: { keys?: CoercedType, values?: CoercedType } };

/** a composite coerced value (array/object shaped) cannot be losslessly joined into a
 * flat separator string, so serialization for these always falls back to JSON */
export function isCompositeCoercedType(ct: CoercedType | undefined): boolean {
  if (ct === 'object') return true;
  return !!ct && typeof ct === 'object' && ('arrayOf' in ct || 'recordOf' in ct);
}

type EnvGraphDataTypeDef<CoerceReturnType, ValidateInputType = FallbackIfUnknown<CoerceReturnType, string>> = {
  /** this will be the name of the type, used to reference it when using it in a schema */
  name: string;
  // we might automatically prefix with a package/module name when installing plugins?

  /** optional description of the type itself */
  typeDescription?: string;

  // alias names? (ex: allow `@type=bool` and `@type=boolean` to both resolve to the same type)

  /** icon see https://icones.js.org for available options
   * @example mdi:aws
   * */
  icon?: string;
  /** coerce function - should take in any value and return a value of the correct type if possible */
  coerce?: (value: any) => CoerceReturnType | CoercionError | undefined;
  /**
   * validate function - we can assume that coercion has already succeded, or this will not be called
   * - if validation passes, should return true
   * - if validation fails, should return a ValidationError or array of errors - or throw an error
   * */
  validate?: (value: ValidateInputType) => MaybePromise<(true | undefined | void | Error | Array<Error>)>;

  /**
   * Optional placeholder generator used by proxy mode. Receives a unique,
   * format-safe `seed` (lowercase alphanumerics + hyphens, derived from the item
   * key) and should return a value that (a) is a valid instance of this type so it
   * passes an SDK's format checks, and (b) embeds the seed so distinct items get
   * distinct placeholders (required so wire scrubbing can't confuse two secrets).
   * Return undefined when no valid-and-unique form exists for this type.
   */
  generatePlaceholder?: (seed: string) => string | undefined;

  /**
   * what shape `coerce` outputs — lets code generation emit properly typed fields
   * (e.g. `int` in Go) instead of assuming `string`. Omit for string-valued types.
   */
  coercedType?: CoercedType;

  /**
   * serialize a coerced value back to the string form injected into process.env.
   * Defaults to `String(value)` — composite types (array/object) override this so
   * child processes receive a usable flat string (separator-joined or JSON).
   */
  serialize?: (value: any) => string;

  // asyncValidate? - async validation function, meant to be called more sparingly
  // for example, when could validate an API key is currently valid

  // add function to validate instance settings are ok (no conflicts, missing required, etc)

  /** will make items of this type sensitive, unless overridden specifically on that item */
  sensitive?: boolean,

  /**
   * will make items of this type internal (used only by varlock, not injected into the app),
   * unless overridden specifically on that item via `@internal=false`.
   * Useful for credentials like a service-account token that fetch other secrets but
   * are very rarely needed in application code.
   */
  internal?: boolean,

  /** adds docs info for these  */
  docs?: Array<string | { url: string, description: string }>;
  // do we want to allow adding settings that usually come from other decorators?
  // specific items - docs, sensitive, example, etc
  // or just a way to add arbitrary other decorators?
};


/**
 * holds a specific instance of a data type, along with specific settings which affect validation/coercion etc
 */
export class EnvGraphDataType {
  constructor(
    private def: EnvGraphDataTypeDef<any, any>,
    /** reference back to the factory function, which we can use like a constructor to check the type of the instance */
    private factory: any,
  ) {}

  get name() { return this.def.name; }
  get icon() { return this.def.icon; }
  get isSensitive() { return this.def.sensitive; }
  get isInternal() { return this.def.internal; }
  get docsEntries() { return this.def.docs; }
  get coercedType() { return this.def.coercedType; }

  generatePlaceholder(seed: string) {
    return this.def.generatePlaceholder?.(seed);
  }

  /** @internal */
  get _rawDef() { return this.def; }

  coerce(val: any) {
    if (this.def.coerce) return this.def.coerce(val);
    // if no coerce function is defined, we'll default to converting to a string
    if (val === undefined) return undefined;
    return typeof val === 'string' ? val : String(val);
  }

  validate(val: any) {
    return this.def.validate ? this.def.validate(val) : true;
  }

  /** serialize a coerced value back to the string form injected into process.env */
  serialize(val: any): string {
    if (val === undefined || val === null) return '';
    if (this.def.serialize) return this.def.serialize(val);
    return typeof val === 'string' ? val : String(val);
  }
}
// but we can pass in a function if the data type accepts additional usage options

export function createEnvGraphDataType<TsType, InstanceSettingsArgs extends Array<any>>(
  dataTypeDef:
    EnvGraphDataTypeDef<TsType>
    | ((...args: InstanceSettingsArgs) => EnvGraphDataTypeDef<TsType>),
) {
  const typeFactoryFn = (...usageOpts: InstanceSettingsArgs) => {
    return new EnvGraphDataType(
      _.isFunction(dataTypeDef) ? dataTypeDef(...usageOpts) : dataTypeDef,
      typeFactoryFn,
    );
  };
  typeFactoryFn._isEnvGraphDataTypeFactory = true;
  // create a dummy instance just so we can get the name
  const exampleInstance = typeFactoryFn(...[] as any);
  typeFactoryFn.dataTypeName = exampleInstance.name;

  return typeFactoryFn;
}

export type EnvGraphDataTypeFactory = ReturnType<typeof createEnvGraphDataType>;

/// BASE DATA TYPES //////////////////////////////////////////////////////////////////////

function coerceToString(rawVal: any) {
  if (rawVal === undefined || rawVal === null) return '';
  return _.isString(rawVal) ? rawVal : String(rawVal);
}

function coerceToNumber(rawVal: any) {
  let numVal!: number;
  if (_.isString(rawVal)) {
    const parsed = parseFloat(rawVal);
    if (_.isNan(parsed) || parsed === Infinity || parsed === -Infinity) {
      throw new CoercionError('Unable to coerce string to number');
    }
    numVal = parsed;
  } else if (_.isNumber(rawVal)) {
    if (rawVal === Infinity || rawVal === -Infinity) {
      throw new CoercionError('Infinity is not a valid number');
    }
    numVal = rawVal;
  } else {
    throw new CoercionError(`Cannot convert ${rawVal} to number`);
  }
  return numVal;
}

/** Deterministic lowercase hex derived from a placeholder seed (for uuid/md5 forms). */
function hexFromSeed(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

const StringDataType = createEnvGraphDataType(
  (settings?: {
    /** The minimum length of the string. */
    minLength?: number;
    /** The maximum length of the string. */
    maxLength?: number;
    /** The exact length of the string. */
    isLength?: number;
    /** The required starting substring of the string. */
    startsWith?: string;
    /** The required ending substring of the string. */
    endsWith?: string;

    /** The regular expression or string pattern that the string must match. */
    matches?: RegExp | string;

    // could add some shorthands for matching common patterns (isAlphaNumeric, etc...)
    // could add allow/deny character lists?

    // more stuff?
    /** converts to upper case */
    toUpperCase?: boolean;
    /** converts to lower case */
    toLowerCase?: boolean;

    /** allow empty string as a valid string (default is to NOT allow it) */
    allowEmpty?: boolean;
  }) => ({
    name: 'string',
    icon: 'carbon:string-text',
    coerce: (rawVal) => {
      // coerceToString will convert undefined to '', but this code should not even get called when that is the case
      let val = coerceToString(rawVal);
      // should we JSON.stringify objects?
      if (settings?.toUpperCase) val = val.toUpperCase();
      if (settings?.toLowerCase) val = val.toLowerCase();
      return val;
    },
    validate: (val) => {
      // we support returning multiple errors and our base types use this pattern
      // but many user defined types should just throw the first error they encounter
      const errors = [] as Array<ValidationError>;

      // TODO: not sure if we want this?
      // // special handling to not allow empty strings (unless explicitly allowed)
      // if (val === '' && !settings?.allowEmpty) {
      //   return [new ValidationError('If set, string must not be empty')];
      // }

      if (settings?.minLength !== undefined && val.length < settings.minLength) {
        errors.push(new ValidationError(`Length must be more than ${settings.minLength}`));
      }
      if (settings?.maxLength !== undefined && val.length > settings.maxLength) {
        errors.push(new ValidationError(`Length must be less than ${settings.maxLength}`));
      }
      if (settings?.isLength !== undefined && val.length !== settings.isLength) {
        errors.push(new ValidationError(`Length must be exactly ${settings.isLength}`));
      }

      if (settings?.startsWith && !val.startsWith(settings.startsWith)) {
        errors.push(new ValidationError(`Value must start with "${settings.startsWith}"`));
      }
      if (settings?.endsWith && !val.endsWith(settings.endsWith)) {
        errors.push(new ValidationError(`Value must end with "${settings.endsWith}"`));
      }

      if (settings?.matches) {
        let regex: RegExp;
        if (_.isString(settings.matches)) {
          regex = parseRegexLikeString(settings.matches) ?? new RegExp(settings.matches);
        } else {
          regex = settings.matches;
        }
        const matches = val.match(regex);
        if (!matches) {
          errors.push(new ValidationError(`Value must match regex "${settings.matches}"`));
        }
      }
      return errors.length ? errors : true;
    },
  }),
);



/**
 * Represents a generic number data type.
 * @category Base Types
 */
const NumberDataType = createEnvGraphDataType(
  (settings?: {
    /** minimum value allowed for the number */
    min?: number;
    /** maximum value allowed for the number */
    max?: number;
    /** enables coercion of the value to be within the min/max range */
    coerceToMinMaxRange?: boolean;
    /** checks if value is divisible by this number */
    isDivisibleBy?: number;
  } & (
    {
      /** checks if it's an integer */
      isInt: true;
    } | {
      isInt?: never;
      /** The number of decimal places allowed (for non-integers) */
      precision?: number
    }
  )) => ({
    name: 'number',
    icon: 'carbon:string-integer',
    // an integer only when constrained (isInt / precision=0) — coerce() rounds in that case
    coercedType: (settings?.isInt === true || settings?.precision === 0) ? 'int' : 'number',
    coerce(rawVal) {
      let numVal = coerceToNumber(rawVal);
      if (settings?.coerceToMinMaxRange) {
        if (settings?.min !== undefined) numVal = Math.max(settings?.min, numVal);
        if (settings?.max !== undefined) numVal = Math.min(settings?.max, numVal);
      }

      // not sure if we want to coerce to integer by default, versus just checking
      if (settings?.isInt === true || settings?.precision === 0) {
        numVal = Math.round(numVal);
      } else if (settings?.precision) {
        const p = 10 ** settings.precision;
        numVal = Math.round(numVal * p) / p;
      }
      return numVal;
    },
    validate(val) {
      const errors = [] as Array<ValidationError>;
      if (settings?.min !== undefined && val < settings?.min) {
        errors.push(new ValidationError(`Min value is ${settings?.min}`));
      }
      if (settings?.max !== undefined && val > settings?.max) {
        errors.push(new ValidationError(`Max value is ${settings?.max}`));
      }
      if (settings?.isDivisibleBy !== undefined && val % settings.isDivisibleBy !== 0) {
        errors.push(new ValidationError(`Value must be divisible by ${settings?.isDivisibleBy}`));
      }
      return errors.length ? errors : true;
    },

  }),
);


const BooleanDataType = createEnvGraphDataType({
  name: 'boolean',
  icon: 'carbon:boolean',
  coercedType: 'boolean',
  // probably want allow some settings
  // - more strict about coercion or adding additional true/false values
  // - coercing to other values - like 0,1
  coerce(val) {
    if (_.isBoolean(val)) {
      return val;
    } else if (_.isString(val)) {
      const cleanVal = val.toLowerCase().trim();
      if (['t', 'true', 'yes', 'on', '1'].includes(cleanVal)) return true;
      if (['f', 'false', 'no', 'off', '0'].includes(cleanVal)) return false;
      throw new CoercionError('Unable to coerce string value to boolean');
    } else if (_.isNumber(val)) {
      if (val === 0) return false;
      if (val === 1) return true;
      throw new CoercionError('Unable to coerce number value to boolean (only 0 or 1 is valid)');
    } else {
      throw new CoercionError('Unable to coerce value to boolean');
    }
  },
  // TODO: add settings to be more strict, or to allow other values to coerce to true/false
  validate(val) {
    if (_.isBoolean(val)) return true;
    return new ValidationError('Value must be `true` or `false`');
  },
});


// Common non-primitive types ///////////////////////////////////////////////////////////////
const UrlDataType = createEnvGraphDataType(
  (settings?: {
    prependHttps?: boolean
    allowedDomains?: Array<string>
    /** Disallow a trailing slash on the URL path. */
    noTrailingSlash?: boolean
    /** A regular expression or string pattern that the full URL must match. */
    matches?: RegExp | string
  }) => ({
    name: 'url',
    icon: 'carbon:url',
    // A valid, unique, non-routable URL (`.invalid` is reserved, RFC 2606).
    generatePlaceholder: (seed) => `https://${seed}.invalid/`,
    coerce(rawVal) {
      const val = coerceToString(rawVal);
      if (settings?.prependHttps && !val.startsWith('https://')) return `https://${val}`;
      return val;
    },
    validate(val) {
      let url: URL;
      try {
        url = new URL(val); // if invalid, this will throw
      } catch (err) {
        throw new ValidationError('Invalid URL');
      }
      const errors = [] as Array<ValidationError>;
      if (
        settings?.allowedDomains && !settings.allowedDomains.includes(url.host.toLowerCase())
      ) {
        errors.push(new ValidationError(`Domain (${url.host}) is not in allowed list: ${settings.allowedDomains.join(',')}`));
      }
      if (settings?.noTrailingSlash && val.endsWith('/')) {
        errors.push(new ValidationError('URL must not have a trailing slash'));
      }
      if (settings?.matches) {
        let regex: RegExp;
        if (_.isString(settings.matches)) {
          regex = parseRegexLikeString(settings.matches) ?? new RegExp(settings.matches);
        } else {
          regex = settings.matches;
        }
        if (!regex.test(val)) {
          errors.push(new ValidationError(`URL must match regex "${settings.matches}"`));
        }
      }
      return errors.length ? errors : true;
    },
  }),
);


const SimpleObjectDataType = createEnvGraphDataType({
  name: 'simple-object',
  icon: 'tabler:code-dots', // curly brackets with nothing inside
  coercedType: 'object',
  coerce(val) {
    if (_.isPlainObject(val)) return val;
    // if value is a string, we'll try to JSON.parse and see if that is an object
    if (_.isString(val)) {
      try {
        const parsedObj = JSON.parse(val);
        if (_.isPlainObject(parsedObj)) return parsedObj;
        return new CoercionError('Unable to coerce JSON parsed string to object');
      } catch (err) {
        return new CoercionError('Error parsing JSON string while coercing string to object');
      }
    }
    return new CoercionError('Cannot coerce value to object');
  },
  validate(val) {
    if (_.isPlainObject(val)) return true;
    return new ValidationError('Value must be an object');
  },
  // without this, process.env injection would stringify to "[object Object]"
  serialize: (val) => JSON.stringify(val),
});



type PossibleEnumValues = string | number | boolean; // do we need explicitly allow null/undefined?

// might want extended enum types that include more metadata
// also might want 1st class support for an "array of enum" type

const EnumDataType = createEnvGraphDataType(
  (...enumOptions: Array<PossibleEnumValues>) => ({
    name: 'enum',
    icon: 'material-symbols-light:category', // a few shapes... not sure about this one
    coercedType: { enum: enumOptions },
    coerce(val) {
      if (_.isString(val) || _.isNumber(val) || _.isBoolean(val)) return val;
      return new CoercionError('Value must be a string, number, or boolean');
    },
    validate(val) {
      const possibleValues: Array<any> = enumOptions || [];
      if (!possibleValues.includes(val)) {
        throw new ValidationError('Current value is not in list of possible values', {
          tip: `Possible values are: "${possibleValues.join('", "')}"`,
        });
      }
    },
  }),
);

const EMAIL_REGEX = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
const EmailDataType = createEnvGraphDataType(
  (settings?: {
    normalize?: boolean
  }) => ({
    name: 'email',
    icon: 'iconoir:at-sign',
    typeDescription: 'standard email address',
    // A valid, unique address at the reserved `.invalid` TLD (RFC 2606).
    generatePlaceholder: (seed) => `${seed}@placeholder.invalid`,
    coerce(rawVal) {
      let val = coerceToString(rawVal);
      if (settings?.normalize) val = val.toLowerCase();
      return val;
    },
    validate(val) {
      // check if it's a valid email - which could def have some edge case issues
      const result = EMAIL_REGEX.test(val);
      if (result) return true;
      return new ValidationError('Value must be a valid email address');
    },
  }),
);

const IP_V4_ADDRESS_REGEX = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/;
const IP_V6_ADDRESS_REGEX = /^(?:(?:[a-fA-F\d]{1,4}:){7}(?:[a-fA-F\d]{1,4}|:)|(?:[a-fA-F\d]{1,4}:){6}(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|:[a-fA-F\d]{1,4}|:)|(?:[a-fA-F\d]{1,4}:){5}(?::(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,2}|:)|(?:[a-fA-F\d]{1,4}:){4}(?:(?::[a-fA-F\d]{1,4}){0,1}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,3}|:)|(?:[a-fA-F\d]{1,4}:){3}(?:(?::[a-fA-F\d]{1,4}){0,2}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,4}|:)|(?:[a-fA-F\d]{1,4}:){2}(?:(?::[a-fA-F\d]{1,4}){0,3}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,5}|:)|(?:[a-fA-F\d]{1,4}:){1}(?:(?::[a-fA-F\d]{1,4}){0,4}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,6}|:)|(?::(?:(?::[a-fA-F\d]{1,4}){0,5}:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}|(?::[a-fA-F\d]{1,4}){1,7}|:)))(?:%[0-9a-zA-Z]{1,})?$/;
const IpAddressDataType = createEnvGraphDataType(
  (settings?: {
    version?: 4 | 6,
    normalize?: boolean,
  }) => ({
    name: 'ip',
    icon: 'iconoir:ip-address-tag',
    typeDescription: 'ip v4 or v6 address',
    coerce(rawVal) {
      let val = coerceToString(rawVal);
      if (settings?.normalize) val = val.toLowerCase();
      return val;
    },
    validate(val) {
      // default to v4
      const regex = settings?.version === 6 ? IP_V6_ADDRESS_REGEX : IP_V4_ADDRESS_REGEX;
      const result = regex.test(val);
      if (result) return true;
      return new ValidationError('Value must be a valid IP address');
    },
  }),
);

const PortDataType = createEnvGraphDataType(
  (settings?: {
    min?: number;
    max?: number;
  }) => ({
    name: 'port',
    icon: 'material-symbols:captive-portal', //! globe with arrow - not sure about this one
    typeDescription: 'valid port number between 0 and 65535',
    coercedType: 'int',
    coerce(rawVal) {
      if (_.isString(rawVal)) {
        if (rawVal.includes('.')) throw new CoercionError('Port number must be an integer');
        if (rawVal.includes('e')) throw new CoercionError('Port number should be an integer, not in exponential notation');
      }
      return coerceToNumber(rawVal);
    },
    validate(val) {
      if (settings?.min !== undefined && val < settings?.min) {
        return new ValidationError(`Min value is ${settings?.min}`);
      }
      if (settings?.max !== undefined && val > settings?.max) {
        return new ValidationError(`Max value is ${settings?.max}`);
      }
      if (val < 0 || val > 65535) {
        return new ValidationError('Value must be a valid port number (0-65535)');
      }
      return true;
    },
  }),
);

const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const SemverDataType = createEnvGraphDataType(
  (_settings?: {}) => ({
    name: 'semver',
    icon: 'simple-icons:semver',
    typeDescription: 'semantic version string',
    validate(val) {
      const result = SEMVER_REGEX.test(val);
      if (result) return true;
      return new ValidationError('Value must be a valid semantic version string');
    },
  }),
);

// https://rgxdb.com/r/526K7G5W
const ISO_DATE_REGEX = /^(?:[+-]?\d{4}(?!\d{2}\b))(?:(-?)(?:(?:0[1-9]|1[0-2])(?:\1(?:[12]\d|0[1-9]|3[01]))?|W(?:[0-4]\d|5[0-2])(?:-?[1-7])?|(?:00[1-9]|0[1-9]\d|[12]\d{2}|3(?:[0-5]\d|6[1-6])))(?:[T\s](?:(?:(?:[01]\d|2[0-3])(?:(:?)[0-5]\d)?|24:?00)(?:[.,]\d+(?!:))?)?(?:\2[0-5]\d(?:[.,]\d+)?)?(?:[zZ]|(?:[+-])(?:[01]\d|2[0-3]):?(?:[0-5]\d)?)?)?)?$/;
const IsoDateDataType = createEnvGraphDataType({
  name: 'isoDate',
  icon: 'formkit:datetime',
  typeDescription: 'ISO 8601 date string with optional time and milliseconds',
  validate(val) {
    // could add options for dateonly, time only, etc...
    const result = ISO_DATE_REGEX.test(val);
    if (result) return true;
    return new ValidationError('Value must be a valid ISO 8601 date string');
  },
});


const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UuidDataType = createEnvGraphDataType({
  name: 'uuid',
  icon: 'mdi:identifier',
  typeDescription: 'UUID string V1-V5 per RFC4122, including NIL',
  // A deterministic, unique, valid v4-shaped UUID derived from the seed.
  generatePlaceholder: (seed) => {
    const hex = hexFromSeed(seed);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  },
  validate(val) {
    const result = UUID_REGEX.test(val);
    if (result) return true;
    return new ValidationError('Value must be a valid UUID string');
  },
});

const MD5_REGEX = /^[a-f0-9]{32}$/;
const Md5DataType = createEnvGraphDataType({
  name: 'md5',
  typeDescription: 'MD5 hash string',
  // A deterministic, unique, valid 32-hex string derived from the seed.
  generatePlaceholder: (seed) => hexFromSeed(seed).slice(0, 32),
  validate(val) {
    const result = MD5_REGEX.test(val);
    if (result) return true;
    return new ValidationError('Value must be a valid MD5 hash string');
  },
});


const VALID_DURATION_UNITS: ReadonlyArray<DurationUnit> = ['ms', 'seconds', 'minutes', 'hours', 'days', 'weeks'];

/**
 * Flexible duration type. Accepts human-readable strings ("1h", "30m", "500ms",
 * "2days") or bare numbers (interpreted as milliseconds), and outputs a number
 * in the unit specified by the `output` setting (default: `ms`).
 *
 * @example
 *   # @type=duration                       → "1h" coerces to 3600000
 *   # @type=duration(output="seconds")     → "1h" coerces to 3600
 *   # @type=duration(output="minutes")     → "1h" coerces to 60
 */
const DurationDataType = createEnvGraphDataType(
  (settings?: {
    /** Unit to output. Defaults to "ms". */
    output?: DurationUnit;
    /** Optional minimum duration, in the same input format (e.g. "1s"). */
    min?: string | number;
    /** Optional maximum duration, in the same input format. */
    max?: string | number;
  }) => ({
    name: 'duration',
    icon: 'mdi:timer-outline',
    typeDescription: 'flexible duration (accepts "1h", "30m", "500ms", "2days", etc. — outputs ms by default)',
    // can be fractional after unit conversion (e.g. "90s" output in minutes), so a general number
    coercedType: 'number',
    coerce(rawVal) {
      if (rawVal === undefined || rawVal === null) return undefined;
      const output = settings?.output ?? 'ms';
      if (!VALID_DURATION_UNITS.includes(output)) {
        throw new CoercionError(`Invalid duration output unit: "${output}" — valid: ${VALID_DURATION_UNITS.join(', ')}`);
      }
      try {
        const ms = parseDuration(rawVal as string | number);
        return convertDurationFromMs(ms, output);
      } catch (err) {
        throw new CoercionError((err as Error).message);
      }
    },
    validate(val) {
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        return new ValidationError('Duration must be a finite number');
      }
      const output = settings?.output ?? 'ms';
      if (settings?.min !== undefined) {
        const minMs = parseDuration(settings.min);
        const minInOutput = convertDurationFromMs(minMs, output);
        if (val < minInOutput) {
          return new ValidationError(`Duration must be at least ${settings.min}`);
        }
      }
      if (settings?.max !== undefined) {
        const maxMs = parseDuration(settings.max);
        const maxInOutput = convertDurationFromMs(maxMs, output);
        if (val > maxInOutput) {
          return new ValidationError(`Duration must be at most ${settings.max}`);
        }
      }
      return true;
    },
  }),
);


/// COMPOSITE DATA TYPES (array / object) ///////////////////////////////////////////////

/**
 * Run a nested type's validate() and normalize every possible outcome (throw, returned
 * error, returned array, `false`) into a flat list of ValidationErrors — mirrors the
 * handling in ConfigItem.resolve() so element validation behaves like item validation.
 */
async function runNestedValidate(type: EnvGraphDataType, val: any): Promise<Array<ValidationError>> {
  const asValidationError = (err: Error) => (
    err instanceof ValidationError ? err : new ValidationError(err.message, { err })
  );
  try {
    const result = await type.validate(val);
    if (result instanceof Error) return [asValidationError(result)];
    if (_.isArray(result)) return result.filter((e) => e instanceof Error).map(asValidationError);
    if ((result as any) === false) return [new ValidationError('validation failed with `false` return value')];
    return [];
  } catch (err) {
    if (_.isArray(err)) return err.filter((e) => e instanceof Error).map(asValidationError);
    if (err instanceof Error) return [asValidationError(err)];
    return [new ValidationError(`Unexpected non-error thrown during validation - ${err}`)];
  }
}

/** re-wrap a nested validation error with a positional prefix (array index / object key) */
function prefixValidationError(prefix: string, err: ValidationError): ValidationError {
  return new ValidationError(`${prefix} ${err.message}`, { err, tip: err.tip });
}

const DEFAULT_ARRAY_SEPARATOR = ',';

export type ArrayDataTypeSettings = {
  /** minimum number of elements */
  minLength?: number;
  /** maximum number of elements */
  maxLength?: number;
  /** exact number of elements */
  isLength?: number;
  /** reject duplicate elements */
  unique?: boolean;
  /**
   * separator used both to split plain-string input (e.g. a process.env override)
   * and to join the value back into a string for process.env injection (default ",")
   */
  separator?: string;
  /**
   * how the value serializes back into process.env - "separator" (default) joins
   * elements with the separator; "json" emits a JSON array string. Composite element
   * types (arrays/objects) always use JSON regardless of this setting.
   */
  format?: 'separator' | 'json';
  /** element type instance - built from the first positional arg of `@type=array(...)` */
  element?: EnvGraphDataType;
  /** element type display name (e.g. `enum`) for messages/descriptions */
  elementTypeName?: string;
};

const ArrayDataType = createEnvGraphDataType((settings?: ArrayDataTypeSettings) => {
  const element = settings?.element ?? StringDataType();
  const elementTypeName = settings?.elementTypeName ?? element.name;
  const separator = settings?.separator ?? DEFAULT_ARRAY_SEPARATOR;
  // composite elements cannot round-trip through a separator-joined string
  const jsonOnly = settings?.format === 'json' || isCompositeCoercedType(element.coercedType);

  return {
    name: 'array',
    icon: 'tabler:brackets',
    typeDescription: `array of ${elementTypeName}`,
    coercedType: { arrayOf: element.coercedType ?? 'string' },
    coerce(rawVal) {
      let arr: Array<unknown>;
      if (Array.isArray(rawVal)) {
        arr = rawVal;
      } else if (_.isString(rawVal)) {
        const trimmed = rawVal.trim();
        if (trimmed === '') {
          arr = [];
        } else if (trimmed.startsWith('[')) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch (err) {
            return new CoercionError('Error parsing string starting with `[` as a JSON array', { err: err as Error });
          }
          if (!Array.isArray(parsed)) return new CoercionError('JSON-parsed string value is not an array');
          arr = parsed;
        } else {
          arr = trimmed.split(separator).map((part) => part.trim()).filter((part) => part !== '');
        }
      } else {
        return new CoercionError('Cannot coerce value to an array');
      }

      // coerce each element with the element type, collecting ALL failures (not just the first)
      const coerced: Array<unknown> = [];
      const elementErrors: Array<string> = [];
      for (let i = 0; i < arr.length; i++) {
        try {
          const result = element.coerce(arr[i]);
          if (result instanceof Error) throw result;
          coerced.push(result);
        } catch (err) {
          elementErrors.push(`[${i}] ${(err as Error).message}`);
        }
      }
      if (elementErrors.length) {
        return new CoercionError(`Invalid array element(s): ${elementErrors.join('; ')}`);
      }
      return coerced;
    },
    async validate(val) {
      const arr = val as Array<unknown>;
      const errors: Array<ValidationError> = [];

      if (settings?.minLength !== undefined && arr.length < settings.minLength) {
        errors.push(new ValidationError(`Array must have at least ${settings.minLength} element(s)`));
      }
      if (settings?.maxLength !== undefined && arr.length > settings.maxLength) {
        errors.push(new ValidationError(`Array must have at most ${settings.maxLength} element(s)`));
      }
      if (settings?.isLength !== undefined && arr.length !== settings.isLength) {
        errors.push(new ValidationError(`Array must have exactly ${settings.isLength} element(s)`));
      }
      if (settings?.unique) {
        const seen = new Set<string | undefined>();
        for (let i = 0; i < arr.length; i++) {
          const key = JSON.stringify(arr[i]);
          if (seen.has(key)) errors.push(new ValidationError(`[${i}] duplicate value`));
          seen.add(key);
        }
      }

      for (let i = 0; i < arr.length; i++) {
        // a scalar element containing the separator would not survive the process.env
        // round-trip (the child would re-split it differently), so we reject it upfront
        if (!jsonOnly && String(arr[i]).includes(separator)) {
          errors.push(new ValidationError(
            `[${i}] value contains the "${separator}" separator and would not round-trip through process.env`,
            { tip: 'set format=json, or use a different separator' },
          ));
        }
        const elementErrors = await runNestedValidate(element, arr[i]);
        errors.push(...elementErrors.map((e) => prefixValidationError(`[${i}]`, e)));
      }

      return errors.length ? errors : true;
    },
    serialize(val) {
      const arr = val as Array<unknown>;
      if (jsonOnly) return JSON.stringify(arr);
      return arr.map((el) => element.serialize(el)).join(separator);
    },
  };
});

export type ObjectDataTypeSettings = {
  /** value type instance - built from the first positional arg of `@type=object(...)` */
  values?: EnvGraphDataType;
  /** value type display name for messages/descriptions */
  valuesTypeName?: string;
  /** key validation type instance - built from the `keys=...` option (e.g. `keys=enum(a, b)`) */
  keys?: EnvGraphDataType;
};

const ObjectDataType = createEnvGraphDataType((settings?: ObjectDataTypeSettings) => {
  const valuesType = settings?.values;
  const keysType = settings?.keys;

  let coercedType: CoercedType = 'object';
  if (valuesType || keysType) {
    coercedType = {
      recordOf: {
        ...keysType?.coercedType !== undefined ? { keys: keysType.coercedType } : {},
        ...valuesType ? { values: valuesType.coercedType ?? 'string' } : {},
      },
    };
  }

  return {
    name: 'object',
    icon: 'tabler:code-dots',
    typeDescription: valuesType
      ? `object of ${settings?.valuesTypeName ?? valuesType.name} values`
      : 'object',
    coercedType,
    coerce(rawVal) {
      let obj: Record<string, unknown>;
      if (_.isPlainObject(rawVal)) {
        obj = rawVal;
      } else if (_.isString(rawVal)) {
        const trimmed = rawVal.trim();
        if (trimmed === '') {
          obj = {};
        } else if (trimmed.startsWith('{')) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch (err) {
            return new CoercionError('Error parsing string starting with `{` as a JSON object', { err: err as Error });
          }
          if (!_.isPlainObject(parsed)) return new CoercionError('JSON-parsed string value is not an object');
          obj = parsed as Record<string, unknown>;
        } else {
          return new CoercionError('Cannot coerce value to an object');
        }
      } else {
        return new CoercionError('Cannot coerce value to an object');
      }

      if (!valuesType) return obj;

      // coerce each value with the values type, collecting ALL failures
      const coerced: Record<string, unknown> = {};
      const valueErrors: Array<string> = [];
      for (const [key, value] of Object.entries(obj)) {
        try {
          const result = valuesType.coerce(value);
          if (result instanceof Error) throw result;
          coerced[key] = result;
        } catch (err) {
          valueErrors.push(`"${key}" ${(err as Error).message}`);
        }
      }
      if (valueErrors.length) {
        return new CoercionError(`Invalid object value(s): ${valueErrors.join('; ')}`);
      }
      return coerced;
    },
    async validate(val) {
      const obj = val as Record<string, unknown>;
      const errors: Array<ValidationError> = [];

      for (const [key, value] of Object.entries(obj)) {
        if (keysType) {
          // keys are always strings on the wire; run them through the key type's
          // coerce+validate (e.g. enum membership, string pattern)
          let keyErrors: Array<ValidationError>;
          try {
            const coercedKey = keysType.coerce(key);
            if (coercedKey instanceof Error) throw coercedKey;
            keyErrors = await runNestedValidate(keysType, coercedKey);
          } catch (err) {
            keyErrors = [err instanceof ValidationError ? err : new ValidationError((err as Error).message)];
          }
          errors.push(...keyErrors.map((e) => prefixValidationError(`"${key}" is not a valid key -`, e)));
        }
        if (valuesType) {
          const valueErrors = await runNestedValidate(valuesType, value);
          errors.push(...valueErrors.map((e) => prefixValidationError(`"${key}"`, e)));
        }
      }

      return errors.length ? errors : true;
    },
    // objects have no meaningful flat-string form, so they always serialize as JSON
    serialize: (val) => JSON.stringify(val),
  };
});

export const BaseDataTypes: Array<EnvGraphDataTypeFactory> = [
  StringDataType,
  NumberDataType,
  BooleanDataType,
  SimpleObjectDataType,
  EnumDataType,
  EmailDataType,
  UrlDataType,
  IpAddressDataType,
  PortDataType,
  SemverDataType,
  IsoDateDataType,
  UuidDataType,
  Md5DataType,
  DurationDataType,
  ArrayDataType,
  ObjectDataType,
];
