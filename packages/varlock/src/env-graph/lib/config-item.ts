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
import {
  convertParsedValueToResolvers, type ResolvedValue, type Resolver, StaticValueResolver,
} from './resolver';
import { ItemDecoratorInstance } from './decorators';

export type ConfigItemDef = {
  description?: string;
  // TODO: translate parser decorator class into our own generic version
  parsedDecorators?: Array<ParsedEnvSpecDecorator>;
  parsedValue: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | undefined;

  resolver?: Resolver;
  decorators?: Array<ItemDecoratorInstance>;
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
  }

  /**
   * fetch ordered list of definitions for this item, by following up sorted data sources list
   */
  get defs() {
    // TODO: this is somewhat inneficient, because some of the checks on the data source follow up the parent chain
    // we may want to cache the definition list at some point when loading is complete
    // although we need it to be dynamic during the loading process when doing any early resolution of the envFlag
    const defs: Array<ConfigItemDefAndSource> = [];
    for (const source of this.envGraph.sortedDataSources) {
      if (!source.configItemDefs[this.key]) continue;
      if (source.disabled) continue;
      if (source.importKeys && !source.importKeys.includes(this.key)) continue;
      const itemDef = source.configItemDefs[this.key];
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
    const explicitIconDec = this.getDec('icon');
    if (explicitIconDec) return explicitIconDec.resolvedValue;
    return this.dataType?.icon;
  }
  get docsLinks() {
    // matching { url, description } from OpenAPI
    const links: Array<{ url: string, description?: string }> = [];

    // add docs info from the data type
    if (this.dataType?.docsEntries) {
      for (const entry of this.dataType.docsEntries) {
        if (_.isPlainObject(entry)) links.push(entry);
        else links.push({ url: entry });
      }
    }

    const docsUrlDec = this.getDec('docsUrl');
    if (docsUrlDec) {
      links.push({ url: docsUrlDec.resolvedValue });
    }

    const docsDecs = this.getDecFns('docs');
    for (const docsDec of docsDecs) {
      const decVal = docsDec.resolvedValue;
      if (!decVal.arr || !_.isArray(decVal.arr)) throw new Error('expected an array of docs() args');
      if (decVal.arr.length === 1) {
        links.push({ url: decVal.arr[0] });
      } else if (decVal.arr.length === 2) {
        links.push({ url: decVal.arr[1], description: decVal.arr[0] });
      }
    }
    return links;
  }

  get valueResolver() {
    // special case for process.env overrides - always return the static value
    if (this.key in this.envGraph.overrideValues) {
      return new StaticValueResolver(this.envGraph.overrideValues[this.key]);
    }

    for (const def of this.defs) {
      if (def.itemDef.resolver) {
        return def.itemDef.resolver;
      }
    }
  }

  allDecorators: Array<ItemDecoratorInstance> = [];
  effectiveDecorators: Record<string, ItemDecoratorInstance> = {};
  effectiveDecoratorFns: Record<string, Array<ItemDecoratorInstance>> = {};

  getDec(decoratorName: string) {
    return this.effectiveDecorators[decoratorName];
  }
  getDecFns(decoratorName: string) {
    return this.effectiveDecoratorFns[decoratorName] || [];
  }
  async resolveDecorators() {
    // ensures all decorator values have been resolved
    for (const dec of Object.values(this.effectiveDecorators)) {
      await dec.resolve();
    }
    for (const decs of Object.values(this.effectiveDecoratorFns)) {
      for (const dec of decs) {
        await dec.resolve();
      }
    }
  }


  dataType?: EnvGraphDataType;
  _schemaErrors: Array<SchemaError> = [];
  get resolverSchemaErrors() {
    return this.valueResolver?.schemaErrors || [];
  }
  get decoratorSchemaErrors() {
    return _.values(this.allDecorators).flatMap((d) => d.schemaErrors);
  }

  private isProcessed = false;
  async process() {
    if (this.isProcessed) return;
    this.isProcessed = true;

    // process value resolver
    for (const def of this.defs) {
      if (def.itemDef.parsedValue && !def.itemDef.resolver) {
        def.itemDef.resolver = convertParsedValueToResolvers(
          def.itemDef.parsedValue,
          def.source,
          this.envGraph.registeredResolverFunctions,
        );
      }
      await def.itemDef.resolver?.process(this);
    }

    // process decorators and decorator value resolvers
    for (const def of this.defs) {
      def.itemDef.decorators = def.itemDef.parsedDecorators?.map((d) => new ItemDecoratorInstance(this, def.source, d));
      // track all non fn call decs used in this definition - so we can error if used twice
      const decKeysInThisDef = new Set<string>();
      const allDecsInThisDef = def.itemDef.decorators?.map((d) => d.name);
      for (const dec of def.itemDef.decorators || []) {
        await dec.process();
        this.allDecorators?.push(dec);
        // roll up active decorators
        if (dec.isFunctionCall) {
          // collects all function calls into an array
          this.effectiveDecoratorFns[dec.name] ||= [];
          this.effectiveDecoratorFns[dec.name].push(dec);
        } else {
          if (decKeysInThisDef.has(dec.name)) {
            dec._schemaErrors.push(new SchemaError(`decorator @${dec.name} cannot be used twice in same definition`));
            continue;
          }
          if (dec.incompatibleWith) {
            for (const otherDecName of dec.incompatibleWith) {
              if (allDecsInThisDef?.includes(otherDecName)) {
                dec._schemaErrors.push(new SchemaError(`decorator @${dec.name} is incompatible with @${otherDecName} in the same definition`));
                continue;
              }
            }
          }

          // takes a single decorator as the one with most precedence
          this.effectiveDecorators[dec.name] ||= dec;
        }
        decKeysInThisDef.add(dec.name);
      }
    }

    const typeDec = this.getDec('type');
    let dataTypeName: string | undefined;
    let dataTypeArgs: any;
    // TODO: this will not currently support any resolver functions within type settings
    const typeDecParsedValue = typeDec?.parsedDecorator.value;
    if (typeDecParsedValue instanceof ParsedEnvSpecStaticValue) {
      dataTypeName = typeDecParsedValue.value;
    } else if (typeDecParsedValue instanceof ParsedEnvSpecFunctionCall) {
      dataTypeName = typeDecParsedValue.name;
      dataTypeArgs = typeDecParsedValue.simplifiedArgs;
    }
    // if no type is set explicitly, we can try to use inferred type from the resolver
    // currently only static value resolver does this - but you can imagine another resolver knowing the type ahead of time
    // (maybe we only want to do this if the value is set in a schema file? or if all inferred types match?)
    if (!dataTypeName && this.valueResolver?.inferredType) {
      dataTypeName = this.valueResolver.inferredType;
    }
    dataTypeName ||= 'string';
    dataTypeArgs ||= [];

    if (!(dataTypeName in this.envGraph.dataTypesRegistry)) {
      this._schemaErrors.push(new SchemaError(`unknown data type: ${dataTypeName}`));
    } else {
      const dataTypeFactory = this.envGraph.dataTypesRegistry[dataTypeName];
      this.dataType = dataTypeFactory(..._.isPlainObject(dataTypeArgs) ? [dataTypeArgs] : dataTypeArgs);
    }
  }

  get dependencyKeys() {
    return _.uniq([
      ...this.valueResolver?.deps || [],
      ..._.values(this.effectiveDecorators).flatMap(
        (dec) => dec.decValueResolver?.deps || [],
      ),
      ..._.values(this.effectiveDecoratorFns).flatMap(
        (decArr) => decArr.flatMap(
          (d) => d.decValueResolver?.deps || [],
        ),
      ),
    ]);
  }

  /**
   * special early resolution helper
   * currently used to resolve the envFlag before everything else has been loaded
   * */
  async earlyResolve() {
    await this.process();

    // process and resolve any other items our env flag depends on
    for (const depKey of this.dependencyKeys) {
      const depItem = this.envGraph.configSchema[depKey];
      if (!depItem) {
        throw new Error(`eager resolution eror - non-existant dependency: ${depKey}`);
      }
      await depItem.earlyResolve();
    }
    await this.resolve();
  }

  _isRequired: boolean = true;
  /**
   * need to track if required-ness is dynamic, e.g. based on current env
   * because that will affect type generation (only _always_ required items are never undefined)
   * */
  _isRequiredDynamic: boolean = false;

  private async processRequired() {
    try {
      for (const def of this.defs) {
        const requiredDecs = def.itemDef.decorators?.filter((d) => d.name === 'required' || d.name === 'optional') || [];
        // NOTE - checks for duplicates and using required+optional together are already handled more generally
        const requiredDec = requiredDecs[0];

        // Explicit per-item decorators
        if (requiredDec) {
          const usingOptional = requiredDec.name === 'optional';

          // need to track if required-ness is dynamic
          // NOTE - if any other resolver ever has a static value, we'll need to change this
          if (requiredDec.decValueResolver?.fnName !== '\0static') {
            this._isRequiredDynamic = true;
          }

          const requiredDecoratorVal = await requiredDec.resolve();
          // if we got an error, we'll bail and the error will be checked later
          if (requiredDec.schemaErrors.length) {
            // but we mark as not required so we don't _also_ get required error
            this._isRequired = false;
            return;
          }
          if (![true, false, undefined].includes(requiredDecoratorVal)) {
            throw new SchemaError('@required/@optional must resolve to a boolean or undefined');
          }
          if (requiredDecoratorVal !== undefined) {
            this._isRequired = usingOptional ? !requiredDecoratorVal : requiredDecoratorVal;
            return;
          }
        }

        // Root-level @defaultRequired
        const defaultRequiredDec = def.source.getRootDec('defaultRequired');
        if (defaultRequiredDec) {
          const defaultRequiredVal = await defaultRequiredDec.resolve();
          // @defaultRequired = true/false
          if (_.isBoolean(defaultRequiredVal)) {
            this._isRequired = defaultRequiredVal;
            return;

          // @defaultRequired = infer
          // we infer based on if a value is set in this source
          } else if (defaultRequiredVal === 'infer') {
            if (def.itemDef.resolver) {
              if (def.itemDef.resolver instanceof StaticValueResolver) {
                this._isRequired = def.itemDef.resolver.staticValue !== undefined && def.itemDef.resolver.staticValue !== '';
              } else {
                this._isRequired = true;
              }
            } else {
              this._isRequired = false;
            }
            return;
          } else {
            throw new SchemaError('@defaultRequired must resolve to a boolean or "infer"');
          }
        }
      }
    } catch (err) {
      this._schemaErrors.push(err instanceof SchemaError ? err : new SchemaError(err as Error));
    }
  }
  get isRequired() { return this._isRequired; }
  get isRequiredDynamic() { return this._isRequiredDynamic; }


  _isSensitive: boolean = true;
  get isSensitive(): boolean {
    return this._isSensitive;
  }
  private async processSensitive() {
    const sensitiveFromDataType = this.dataType?.isSensitive;
    for (const def of this.defs) {
      const sensitiveDecs = def.itemDef.decorators?.filter((d) => d.name === 'sensitive' || d.name === 'public') || [];
      // NOTE - checks for duplicates and using sensitive+public together are already handled more generally
      const sensitiveDec = sensitiveDecs[0];
      
      // Explicit per-item decorators
      if (sensitiveDec) {
        const usingPublic = sensitiveDec.name === 'public';
        
        const sensitiveDecValue = await sensitiveDec.resolve();
        // can bail if the decorator value resolution failed
        if (sensitiveDec.schemaErrors.length) {
          return;
        }
        if (![true, false, undefined].includes(sensitiveDecValue)) {
          throw new SchemaError('@sensitive/@public must resolve to a boolean or undefined');
        }
        if (sensitiveDecValue !== undefined) {
          this._isSensitive = usingPublic ? !sensitiveDecValue : sensitiveDecValue;
          return;
        }
      }

      // we skip `defaultSensitive` behaviour if the data type specifies sensitivity
      if (sensitiveFromDataType !== undefined) continue;

      const defaultSensitiveDec = def.source.getRootDec('defaultSensitive');
      if (defaultSensitiveDec) {
        if (!defaultSensitiveDec.decValueResolver) throw new Error('expected defaultSensitive to have a value resolver');
        // special case for inferFromPrefix()
        // TODO: formalize this pattern of a root decorator running a function _within the context of an item_
        if (defaultSensitiveDec.decValueResolver.fnName === 'inferFromPrefix') {
          const prefix = defaultSensitiveDec.decValueResolver.arrArgs![0].staticValue;
          if (!_.isString(prefix)) {
            this._schemaErrors.push(new SchemaError('@defaultSensitive inferFromPrefix() requires a single string argument'));
            return;
          }
          this._isSensitive = !this.key.startsWith(prefix);
          return;
        } else {
          const defaultSensitiveVal = await defaultSensitiveDec.resolve();
          if (!_.isBoolean(defaultSensitiveVal)) {
            this._schemaErrors.push(new SchemaError('@defaultSensitive must resolve to a boolean value'));
          } else {
            this._isSensitive = defaultSensitiveVal;
            return;
          }
        }
      }
    }
    if (sensitiveFromDataType !== undefined) this._isSensitive = sensitiveFromDataType;
  }


  get errors() {
    return _.compact([
      ...this._schemaErrors || [],
      ...this.resolverSchemaErrors || [],
      ...this.decoratorSchemaErrors || [],
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
    if (this._schemaErrors.length) return;
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

    await this.resolveDecorators();
    await this.processRequired();
    await this.processSensitive();

    if (!this.valueResolver) {
      this.isResolved = true;
      this.resolvedRawValue = undefined;
    } else {
      try {
        this.resolvedRawValue = await this.valueResolver.resolve();
      } catch (err) {
        if (err instanceof ResolutionError) {
          this.resolutionError = err;
        } else {
          this.resolutionError = new ResolutionError(`error resolving value: ${err}`);
          this.resolutionError.cause = err;
        }
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
      const validateResult = await this.dataType.validate(this.resolvedValue);
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
