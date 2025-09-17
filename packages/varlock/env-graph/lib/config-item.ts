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
import { type ResolvedValue, type Resolver, StaticValueResolver } from './resolver';

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
  // annoyingly we cannot use readonly if we want to support `erasableSyntaxOnly`
  #envGraph: EnvGraph;
  #key: string;

  constructor(
    _envGraph: EnvGraph,
    _key: string,
  ) {
    this.#envGraph = _envGraph;
    this.#key = _key;
  }

  get envGraph() { return this.#envGraph; }
  get key() { return this.#key; }

  /**
   * fetch ordered list of definitions for this item, by following up sorted data sources list
   */
  get defs() {
    // TODO: this is somewhat inneficient, because some of the checks on the data source follow up the parent chain
    // we may want to cache the definition list at some point when loading is complete
    // although we need it to be dynamic during the loading process when doing any early resolution of the envFlag
    const defs: Array<ConfigItemDefAndSource> = [];
    for (const source of this.#envGraph.sortedDataSources) {
      if (!source.configItemDefs[this.#key]) continue;
      if (source.disabled) continue;
      if (source.importKeys && !source.importKeys.includes(this.#key)) continue;
      const itemDef = source.configItemDefs[this.#key];
      if (itemDef) defs.push({ itemDef, source });
    }
    return defs;
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
    // special case for process.env overrides - always return the static value
    if (this.key in this.envGraph.overrideValues) {
      return new StaticValueResolver(this.envGraph.overrideValues[this.key]);
    }

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

    this.processRequired();
  }

  /**
   * special early resolution helper
   * currently used to resolve the envFlag before everything else has been loaded
   * */
  async earlyResolve() {
    await this.process();

    // process and resolve any other items our env flag depends on
    for (const depKey of this.valueResolver?.deps || []) {
      const depItem = this.envGraph.configSchema[depKey];
      if (!depItem) {
        throw new Error(`eager resolution eror - non-existant dependency: ${depKey}`);
      }
      await depItem.process();
      // we are not going to follow a chain of dependencies here
      if (depItem.valueResolver?.deps.length) {
        // TODO: probably should allow this, even though its not going to be common
        throw new Error('eager resolution cannot follow a chain of dependencies');
      }
      await depItem.resolve(true);
    }
    await this.resolve(true);
  }

  _isRequired: boolean = true;
  /**
   * need to track if required-ness is dynamic, e.g. based on current env
   * because that will affect type generation (only _always_ required items are never undefined)
   * */
  _isRequiredDynamic: boolean = false;

  private processRequired() {
    try {
      for (const def of this.defs) {
        const defDecorators = def.itemDef.decorators || {};

        // Explicit per-item decorators
        if ('required' in defDecorators || 'optional' in defDecorators) {
          // cannot use both @required and @optional at same time
          if ('required' in defDecorators && 'optional' in defDecorators) {
            throw new SchemaError('@required and @optional cannot both be set');
          }

          const requiredDecoratorVal = defDecorators.required?.value || defDecorators.optional?.value;
          const usingOptional = 'optional' in defDecorators;
          // static value of  `true` or `false`
          if (requiredDecoratorVal instanceof ParsedEnvSpecStaticValue) {
            const staticVal = requiredDecoratorVal.value;
            if (_.isBoolean(staticVal)) {
              this._isRequired = usingOptional ? !staticVal : staticVal;
            } else {
              throw new SchemaError('@required/@optional can only be set to true/false if using a static value');
            }

          // dynamic / function value - setting based on other values
          } else if (requiredDecoratorVal instanceof ParsedEnvSpecFunctionCall) {
            this._isRequiredDynamic = true;
            const requiredFnName = requiredDecoratorVal.name;
            const requiredFnArgs = requiredDecoratorVal.simplifiedArgs;

            // set required based on current envFlag
            if (requiredFnName === 'forEnv') {
              // get current env from the def's source - which will follow up parent chain if necessary
              const currentEnv = def.source.envFlagValue;
              if (!currentEnv) {
                throw new SchemaError('Cannot set @required using forEnv() because environment flag is not set');
              }
              const envMatches = requiredFnArgs.includes(currentEnv);
              this._isRequired = usingOptional ? !envMatches : envMatches;
            }
          }
          return;
        }

        // Root-level @defaultRequired
        const defaultRequiredValue = def.source.getRootDecoratorSimpleValue('defaultRequired');
        if (defaultRequiredValue !== undefined) {
          if (defaultRequiredValue === 'infer') {
            // Only apply infer logic for schema source
            // ? not sure about this - we could probably still apply it for other sources?
            if (def.source.type === 'schema') {
              const resolver = def.itemDef.resolver;
              if (resolver === undefined) {
                this._isRequired = false;
              } else if (resolver instanceof StaticValueResolver) {
                this._isRequired = resolver.staticValue !== undefined && resolver.staticValue !== '';
              } else {
                this._isRequired = true;
              }
              return;
            } else {
              // Not schema source, skip this def and continue
              continue;
            }
          }
          // explicit true or false
          this._isRequired = defaultRequiredValue;
          return;
        }
      }
    } catch (err) {
      this.schemaErrors.push(err instanceof SchemaError ? err : new SchemaError(err as Error));
    }
  }
  get isRequired() { return this._isRequired; }
  get isRequiredDynamic() { return this._isRequiredDynamic; }

  get isSensitive() {
    for (const def of this.defs) {
      const defDecorators = def.itemDef.decorators || {};
      if ('sensitive' in defDecorators) {
        return defDecorators.sensitive.simplifiedValue;
        // TODO: do we want an opposite decorator similar to @required/@optional -- maybe @public?
      }
      const defaultSensitiveDec = def.source.getRootDecorators('defaultSensitive')[0];
      if (defaultSensitiveDec) {
        // Handle function call: inferFromPrefix(PREFIX)
        if (defaultSensitiveDec.value instanceof ParsedEnvSpecFunctionCall && defaultSensitiveDec.value.name === 'inferFromPrefix') {
          const args = defaultSensitiveDec.value.simplifiedArgs;
          // Accepts a single string prefix as first arg
          const prefix = Array.isArray(args) && args.length > 0 ? args[0] : undefined;
          if (typeof prefix === 'string' && this.key.startsWith(prefix)) {
            return false; // Not sensitive if matches prefix
          }
          return true; // Sensitive otherwise
        }
        // Fallback to static/boolean value
        return defaultSensitiveDec.simplifiedValue;
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

  async resolve(reset = false) {
    // bail early if we have a schema error
    if (this.schemaErrors.length) return;
    if (this.resolverSchemaErrors.length) return;

    if (reset) {
      this.isResolved = false;
      this.isValidated = false;
      this.resolutionError = undefined;
      this.coercionError = undefined;
      this.validationErrors = undefined;
      this.resolvedRawValue = undefined;
      this.resolvedValue = undefined;
    }
    if (this.isResolved) {
      // previously we would throw an error, now we resolve the envFlag early, so we can just return
      // but we may want further checks, as this could help us identify buggy logic calling resolve multiple times
      return;
    }

    if (!this.valueResolver) {
      this.isResolved = true;
      this.resolvedRawValue = undefined;
    } else {
      try {
        this.resolvedRawValue = await this.valueResolver.resolve();
      } catch (err) {
        this.resolutionError = new ResolutionError(`error resolving value: ${err}`);
        this.resolutionError.cause = err;
      }
    }

    if (this.resolvedRawValue instanceof RegExp) {
      this.resolutionError = new ResolutionError('regex() is meant to be used within function args, not as a final resolved value');
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
