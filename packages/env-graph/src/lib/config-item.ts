import _ from '@env-spec/utils/my-dash';
import {
  ParsedEnvSpecDecorator, ParsedEnvSpecFunctionCall, ParsedEnvSpecStaticValue,
} from '@env-spec/parser';

import { EnvGraphDataType } from './data-types';
import { EnvGraph } from './env-graph';
import {
  CoercionError, EmptyRequiredValueError, ResolutionError, SchemaError,
  ValidationError,
} from './errors';

import { EnvGraphDataSource } from './data-source';
import { ResolvedValue, Resolver, StaticValueResolver } from './resolver';

export type ConfigItemDef = {
  description?: string;
  resolver?: Resolver;
  // TODO: translate parser decorator class into our own generic version
  decorators?: Record<string, ParsedEnvSpecDecorator>;
};
export type ConfigItemDefAndSource = {
  itemDef: ConfigItemDef;
  source: EnvGraphDataSource;
};


export class ConfigItem {
  constructor(
    readonly envGraph: EnvGraph,
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
  get icon() {
    const explicitIcon = this.getDecoratorValueString('icon');
    if (explicitIcon) return explicitIcon;
    return this.dataType?.icon;
  }
  get docsLinks() {
    // matching { url, description } from OpenAPI
    const links: Array<{ url: string, description?: string }> = [];
    const docsUrl = this.getDecoratorValueString('docsUrl');
    if (docsUrl) links.push({ url: docsUrl });
    // TODO: add ability to have multiple links, set labels
    return links;
  }

  get valueResolver() {
    for (const def of this.defs) {
      if (def.itemDef.resolver) return def.itemDef.resolver;
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
  getDecoratorValueRaw(decoratorName: string) {
    for (const def of this.defs) {
      const defDecorators = def.itemDef.decorators || {};
      if (decoratorName in defDecorators) {
        return defDecorators[decoratorName].value;
      }
    }
  }
  getDecoratorValueString(decoratorName: string) {
    const dec = this.getDecoratorValueRaw(decoratorName);
    if (dec instanceof ParsedEnvSpecStaticValue) return String(dec.value);
  }


  dataType?: EnvGraphDataType;
  schemaErrors: Array<SchemaError> = [];
  get resolverSchemaErrors() {
    return this.valueResolver?.schemaErrors || [];
  }

  async process() {
    // process resolvers
    for (const def of this.defs) {
      await def.itemDef.resolver?.process(this);
    }

    const typeDecoratorValue = this.getDecoratorValueRaw('type');
    let dataTypeName: string | undefined;
    let dataTypeArgs: any;
    if (typeDecoratorValue instanceof ParsedEnvSpecStaticValue) {
      dataTypeName = typeDecoratorValue.value;
    } else if (typeDecoratorValue instanceof ParsedEnvSpecFunctionCall) {
      dataTypeName = typeDecoratorValue.name;
      dataTypeArgs = typeDecoratorValue.simplifiedArgs;
    }

    // if no type is set explicitly, we can try to use inferred type from the resolver
    // currently only static value resolver does this - but you can imagine another resolver knowing the type ahead of time
    // (maybe we only want to do this if the value is set in a schema file? or if all inferred types match?)
    if (!dataTypeName) {
      if (this.valueResolver?.inferredType) {
        dataTypeName = this.valueResolver.inferredType;
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

      // Explicit per-item decorators
      if ('required' in defDecorators) {
        const val = defDecorators.required.simplifiedValue;
        if (typeof val === 'boolean') return val;
        if (typeof val === 'string') return val === 'true';
        return Boolean(val);
      }
      if ('optional' in defDecorators) {
        const val = defDecorators.optional.simplifiedValue;
        if (typeof val === 'boolean') return !val;
        if (typeof val === 'string') return val !== 'true';
        return !val;
      }

      // Root-level @defaultRequired
      if ('defaultRequired' in def.source.decorators) {
        const val = def.source.decorators.defaultRequired.simplifiedValue;
        if (val === 'infer') {
          const resolver = def.itemDef.resolver;
          if (resolver instanceof StaticValueResolver) {
            return resolver.staticValue !== undefined && resolver.staticValue !== '';
          } else {
            return true; // function value
          }
        }
        return val; // explicit true or false
      }
    }
    // defaults to true
    return true;
  }

  get isSensitive() {
    for (const def of this.defs) {
      const defDecorators = def.itemDef.decorators || {};
      if ('sensitive' in defDecorators) {
        return defDecorators.sensitive.simplifiedValue;
        // TODO: do we want an opposite decorator similar to @required/@optional -- maybe @public?
      } else if ('defaultSensitive' in def.source.decorators) {
        const dec = def.source.decorators.defaultSensitive;
        // Handle function call: inferFromPrefix(PREFIX)
        if (dec.value instanceof ParsedEnvSpecFunctionCall && dec.value.name === 'inferFromPrefix') {
          const args = dec.value.simplifiedArgs;
          // Accepts a single string prefix as first arg
          const prefix = Array.isArray(args) && args.length > 0 ? args[0] : undefined;
          if (typeof prefix === 'string' && this.key.startsWith(prefix)) {
            return false; // Not sensitive if matches prefix
          }
          return true; // Sensitive otherwise
        }
        // Fallback to static/boolean value
        return dec.simplifiedValue;
      }
    }
    return true;
  }


  get errors() {
    return _.compact([
      ...this.schemaErrors || [],
      ...this.resolverSchemaErrors || [],
      this.resolutionError,
      this.coercionError,
      ...this.validationErrors || [],
    ]);
  }

  get validationState(): 'warn' | 'error' | 'valid' {
    const errors = this.errors;
    if (!errors.length) return 'valid';
    return _.some(errors, (e) => !e.isWarning) ? 'error' : 'warn';
  }

  /** resolved value _before coercion_ */
  resolvedRawValue?: ResolvedValue;
  isResolved = false;
  /** resolved value after coercion */
  resolvedValue?: ResolvedValue;
  isValidated = false;

  resolutionError?: ResolutionError;
  coercionError?: CoercionError;
  validationErrors?: Array<ValidationError>;

  get isCoerced() {
    return this.resolvedRawValue !== this.resolvedValue;
  }

  async resolve() {
    // bail early if we have a schema error
    if (this.schemaErrors.length) return;
    if (this.resolverSchemaErrors.length) return;

    // not sure in what cases this may happen - we'll likely always have a resolver?
    if (!this.valueResolver) {
      this.resolvedRawValue = undefined;
      return;
    }

    if (this.isResolved) throw new Error('item already resolved');

    try {
      // TODO: pass in some ctx object?
      this.resolvedRawValue = await this.valueResolver.resolve();
    } catch (err) {
      this.resolutionError = new ResolutionError(`error resolving value: ${err}`);
      this.resolutionError.cause = err;
    }

    // bail if we have an resolution error
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
