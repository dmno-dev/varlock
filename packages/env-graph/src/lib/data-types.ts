import _ from '../utils/my-dash';
import { FallbackIfUnknown } from '../utils/type-utils';
import { CoercionError, ValidationError } from './errors';


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
  validate: (value: ValidateInputType) => (true | undefined | void | Error | Array<Error>);

  // asyncValidate? - async validation function, meant to be called more sparingly
  // for example, when could validate an API key is currently valid

  // add function to validate instance settings are ok (no conflicts, missing required, etc)

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


  coerce(val: any) {
    return this.def.coerce ? this.def.coerce(val) : val;
  }

  validate(val: any) {
    return this.def.validate ? this.def.validate(val) : true;
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
    if (_.isNaN(parsed) || parsed === Infinity || parsed === -Infinity) {
      throw new CoercionError('Unable to coerce string to number');
    }
    numVal = parsed;
  } else if (_.isNumber(rawVal)) {
    if (numVal === Infinity || numVal === -Infinity) {
      throw new CoercionError('Inifinity is not a valid number');
    }
    numVal = rawVal;
  } else {
    throw new CoercionError(`Cannot convert ${rawVal} to number`);
  }
  return numVal;
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
        errors.push(new ValidationError(`Value must start with "${settings.endsWith}"`));
      }

      if (settings?.matches) {
        const regex = _.isString(settings.matches) ? new RegExp(settings.matches) : settings.matches;
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
  }) => ({
    name: 'url',
    icon: 'carbon:url',
    coerce(rawVal) {
      const val = coerceToString(rawVal);
      if (settings?.prependHttps && !val.startsWith('https://')) return `https://${val}`;
      return val;
    },
    validate(val) {
      // if invalid, this will throw - and will be converted into a ValidationError
      const url = new URL(val);
      if (
        settings?.allowedDomains && !settings.allowedDomains.includes(url.host.toLowerCase())
      ) {
        return new ValidationError(`Domain (${url.host}) is not in allowed list: ${settings.allowedDomains.join(',')}`);
      }
      return true;
    },
  }),
);


const SimpleObjectDataType = createEnvGraphDataType({
  name: 'simple-object',
  icon: 'tabler:code-dots', // curly brackets with nothing inside
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
});



type PossibleEnumValues = string | number | boolean; // do we need explicitly allow null/undefined?

// might want extended enum types that include more metadata
// also might want 1st class support for an "array of enum" type

const EnumDataType = createEnvGraphDataType(
  (...enumOptions: Array<PossibleEnumValues>) => ({
    name: 'enum',
    icon: 'material-symbols-light:category', // a few shapes... not sure about this one
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
    _rawEnumOptions: enumOptions,
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
const ipAddressDataType = createEnvGraphDataType(
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
  (settings?: {

  }) => ({
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
  validate(val) {
    const result = MD5_REGEX.test(val);
    if (result) return true;
    return new ValidationError('Value must be a valid MD5 hash string');
  },
});


export const BaseDataTypes = {
  string: StringDataType,
  number: NumberDataType,
  boolean: BooleanDataType,
  simpleObject: SimpleObjectDataType,
  enum: EnumDataType,
  email: EmailDataType,
  url: UrlDataType,
  ipAddress: ipAddressDataType,
  port: PortDataType,
  semver: SemverDataType,
  isoDate: IsoDateDataType,
  uuid: UuidDataType,
  md5: Md5DataType,
};
