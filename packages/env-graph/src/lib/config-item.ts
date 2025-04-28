import {
  ParsedEnvSpecDecorator, ParsedEnvSpecDecoratorValue, ParsedEnvSpecFunctionCall, ParsedEnvSpecStaticValue,
} from '@env-spec/parser';

import { EnvGraphDataType } from './data-types';
import { EnvGraph } from './env-graph';
import {
  CoercionError, EmptyRequiredValueError, ResolutionError, SchemaError,
  ValidationError,
} from './errors';
import _ from '../utils/my-dash';
import { EnvGraphDataSource } from './data-source';

type StaticValue = string | number | boolean | undefined;

type ConfigItemResolver = {
  type: 'static',
  value: StaticValue;
} | {
  type: 'function',
  functionName: string;
  functionArgs: Array<StaticValue> | Record<string, StaticValue>;
};

export type ConfigItemDef = {
  key: string;
  description?: string;
  valueResolver?: ConfigItemResolver;
  decorators?: Record<string, ParsedEnvSpecDecorator>;
};
export type ConfigItemDefAndSource = {
  itemDef: ConfigItemDef;
  source: EnvGraphDataSource;
};


export class ConfigItem {
  constructor(
    private readonly envGraph: EnvGraph,
    readonly key: string,
  ) {
    // nothing to do here?
  }

  defs: Array<ConfigItemDefAndSource> = [];
  addDef(itemDef: ConfigItemDef, source: EnvGraphDataSource) {
    this.defs.unshift({ itemDef, source });
  }


  get description() {
    for (const def of this.defs) {
      if (def.itemDef.description) return def.itemDef.description;
    }
  }

  get valueResolver() {
    for (const def of this.defs) {
      if (def.itemDef.valueResolver) return def.itemDef.valueResolver;
    }
  }

  getDecorator(decoratorName: string) {
    for (const def of this.defs) {
      const defDecorators = def.itemDef.decorators || {};
      if (decoratorName in defDecorators) {
        return defDecorators[decoratorName];
      }
    }
  }
  getDecoratorValue(decoratorName: string) {
    for (const def of this.defs) {
      const defDecorators = def.itemDef.decorators || {};
      if (decoratorName in defDecorators) {
        return defDecorators[decoratorName].value;
      }
    }
  }


  dataType?: EnvGraphDataType;
  schemaErrors: Array<SchemaError> = [];

  async process() {
    const typeDecoratorValue = this.getDecoratorValue('type');
    let dataTypeName: string | undefined;
    let dataTypeArgs: any;
    if (typeDecoratorValue instanceof ParsedEnvSpecStaticValue) {
      dataTypeName = typeDecoratorValue.value;
    } else if (typeDecoratorValue instanceof ParsedEnvSpecFunctionCall) {
      dataTypeName = typeDecoratorValue.name;
      dataTypeArgs = typeDecoratorValue.simplifiedArgs;
    }

    // if no type is set explicitly, we can try to infer the type from a static value
    // (maybe we only want to do this if the value is set in a schema file? or if all types match?)
    if (!dataTypeName) {
      if (this.valueResolver?.type === 'static') {
        const staticValue = this.valueResolver.value;
        if (typeof staticValue === 'string') {
          dataTypeName = 'string';
        } else if (typeof staticValue === 'number') {
          dataTypeName = 'number';
        } else if (typeof staticValue === 'boolean') {
          dataTypeName = 'boolean';
        }
      }
    }

    dataTypeName ||= 'string';
    dataTypeArgs ||= [];

    if (!(dataTypeName in this.envGraph.dataTypesRegistry)) {
      this.schemaErrors.push(new SchemaError(`unknown data type: ${dataTypeName}`));
    } else {
      const dataTypeFactory = this.envGraph.dataTypesRegistry[dataTypeName];
      this.dataType = dataTypeFactory(..._.isPlainObject(dataTypeArgs) ? [dataTypeArgs] : dataTypeArgs);
    }
  }

  get isRequired() {
    for (const def of this.defs) {
      const defDecorators = def.itemDef.decorators || {};
      if ('required' in defDecorators) {
        return defDecorators.required.simplifiedValue;
      } else if ('optional' in defDecorators) {
        return !defDecorators.optional.simplifiedValue;
      } else if ('defaultRequired' in def.source.decorators) {
        return def.source.decorators.defaultRequired.simplifiedValue;
      }
    }
    return true; // otherwise default to true
  }

  get isSensitive() {
    for (const def of this.defs) {
      const defDecorators = def.itemDef.decorators || {};
      if ('sensitive' in defDecorators) {
        return defDecorators.sensitive.simplifiedValue;
        // TODO: do we want an opposite decorator similar to @required/@optional -- maybe @public?
      } else if ('defaultSensitive' in def.source.decorators) {
        return def.source.decorators.defaultSensitive.simplifiedValue;
      }
    }
    return true;
  }


  get validationState(): 'warn' | 'error' | 'valid' {
    if (this.schemaErrors.length) return 'error';
    const errors = _.compact([
      this.coercionError,
      this.resolutionError,
      ...this.validationErrors || [],
    ]);
    if (!errors.length) return 'valid';
    return _.some(errors, (e) => !e.isWarning) ? 'error' : 'warn';
  }

  /** resolved value _before coercion_ */
  resolvedRawValue?: StaticValue;
  isResolved = false;
  /** resolved value after coercion */
  resolvedValue?: StaticValue;
  isValidated = false;

  resolutionError?: ResolutionError;
  coercionError?: CoercionError;
  validationErrors?: Array<ValidationError>;

  get isCoerced() {
    return this.resolvedRawValue !== this.resolvedValue;
  }

  async resolve() {
    const resolver = this.valueResolver;
    if (!resolver) {
      this.resolvedRawValue = undefined;
    } else if (resolver.type === 'static') {
      this.resolvedRawValue = resolver.value;
    } else if (resolver.type === 'function') {
      const registeredResolver = this.envGraph.registeredResolverFunctions[resolver.functionName];
      if (!registeredResolver) {
        this.resolutionError = new ResolutionError(`resolvers function not registered: ${resolver.functionName}`);
      } else {
        try {
          const resolverInstance = registeredResolver(resolver.functionArgs);
          this.resolvedRawValue = (await resolverInstance.resolve({})) as any;
        } catch (err) {
          this.resolutionError = new ResolutionError(`error resolving value: ${err}`);
          this.resolutionError.cause = err;
        }
      }
    }

    // bail if we have an error already
    if (this.resolutionError) return;

    this.isResolved = true;


    // first deal with empty values and checking required
    if (this.resolvedRawValue === undefined || this.resolvedRawValue === '') {
      // we preserve undefined vs empty string - might want to change this?
      this.resolvedValue = this.resolvedRawValue;
      if (this.isRequired) {
        this.validationErrors = [new EmptyRequiredValueError(undefined)];
      }
      return;
    }

    if (!this.dataType) throw new Error('expected dataType to be set');

    // COERCE VALUE - often will do nothing, but gives us a chance to convert strings to numbers, etc
    try {
      const coerceResult = this.dataType.coerce(this.resolvedRawValue);
      if (coerceResult instanceof Error) throw coerceResult;
      this.resolvedValue = coerceResult;
    } catch (err) {
      if (err instanceof CoercionError) {
        this.coercionError = err;
        return;
      } else if (err instanceof Error) {
        this.coercionError = new CoercionError('Unexpected error coercing value');
        this.coercionError.cause = err;
      } else {
        this.coercionError = new CoercionError(`Unexpected non-error throw during coerce - ${err}`);
      }
      return;
    }

    // VALIDATE
    try {
      const validateResult = this.dataType.validate(this.resolvedValue);
      if (
        validateResult instanceof Error
        || (_.isArray(validateResult) && validateResult[0] instanceof Error)
      ) throw validateResult;
      // validation result is supposed to be `true` or error(s), but we'll check for `false` just in case
      if ((validateResult as any) === false) {
        throw new ValidationError('validation failed with `false` return value');
      }
      this.isValidated = true;
    } catch (err) {
      if (_.isArray(err)) {
        // could do more checking...
        this.validationErrors = err as Array<ValidationError>;
      } else if (err instanceof ValidationError) {
        this.validationErrors = [err];
      } else if (err instanceof Error) {
        const validationError = new ValidationError('Unexpected error during validation');
        validationError.cause = err;
        console.log(err);
        this.validationErrors = [validationError];
      } else {
        const validationError = new ValidationError(`Unexpected non-error thrown during validation - ${err}`);
        validationError.cause = err;
        this.validationErrors = [validationError];
      }
      return;
    }
  }

  get isValid() {
    return this.validationState === 'valid';
  }
}

