/**
 * Schema Store Extensions for @env-spec
 * Adds support for additional decorators used by the Environment Schema Store
 */

export interface SchemaStoreDecorators {
  // Package metadata
  package?: string[];
  version?: string;
  framework?: string[];
  extends?: string;
  url?: string;

  // Priority levels
  required?: boolean;
  optional?: boolean;
  suggested?: boolean;

  // Value constraints
  pattern?: string;
  enum?: string[];
  min?: number;
  max?: number;
  separator?: string;

  // Type hints
  number?: boolean;
  boolean?: boolean;
  array?: boolean;
  json?: boolean;

  // Documentation
  desc?: string;
  example?: string | string[];
  alias?: string;

  // Security
  secret?: boolean;
  public?: boolean;

  // Schema control
  load?: string[];
  exclude?: string[];
  override?: Record<string, string>;
}

export class SchemaStoreParser {
  /**
   * Parse schema store specific decorators
   */
  static parseDecorators(decorators: any[]): SchemaStoreDecorators {
    const result: SchemaStoreDecorators = {};

    for (const decorator of decorators) {
      const name = decorator.name;
      const value = decorator.valueOrFnArgs;

      switch (name) {
        // Package metadata
        case 'package':
          result.package = this.parseStringArray(value);
          break;
        case 'version':
          result.version = this.parseString(value);
          break;
        case 'framework':
          result.framework = this.parseStringArray(value);
          break;
        case 'extends':
          result.extends = this.parseString(value);
          break;
        case 'url':
          result.url = this.parseString(value);
          break;

        // Priority levels
        case 'required':
          result.required = true;
          break;
        case 'optional':
          result.optional = true;
          break;
        case 'suggested':
          result.suggested = true;
          break;

        // Value constraints
        case 'pattern':
          result.pattern = this.parseString(value);
          break;
        case 'enum':
          result.enum = this.parseStringArray(value);
          break;
        case 'min':
          result.min = this.parseNumber(value);
          break;
        case 'max':
          result.max = this.parseNumber(value);
          break;
        case 'separator':
          result.separator = this.parseString(value);
          break;

        // Type hints
        case 'number':
          result.number = true;
          break;
        case 'boolean':
          result.boolean = true;
          break;
        case 'array':
          result.array = true;
          break;
        case 'json':
          result.json = true;
          break;

        // Documentation
        case 'desc':
          result.desc = this.parseString(value);
          break;
        case 'example':
          const examples = this.parseStringArray(value);
          result.example = examples.length === 1 ? examples[0] : examples;
          break;
        case 'alias':
          result.alias = this.parseString(value);
          break;

        // Security
        case 'secret':
          result.secret = true;
          break;
        case 'public':
          result.public = true;
          break;

        // Schema control
        case 'load':
          result.load = this.parseStringArray(value);
          break;
        case 'exclude':
          result.exclude = this.parseStringArray(value);
          break;
        case 'override':
          result.override = this.parseOverrides(value);
          break;
      }
    }

    return result;
  }

  /**
   * Parse string value from decorator
   */
  private static parseString(value: any): string {
    if (!value) return '';
    
    if (typeof value === 'string') {
      return value;
    }
    
    if (value.rawValue) {
      return value.rawValue.replace(/^["'`]|["'`]$/g, '');
    }
    
    return String(value);
  }

  /**
   * Parse string array from decorator
   */
  private static parseStringArray(value: any): string[] {
    if (!value) return [];
    
    // Handle function args format
    if (value.values && Array.isArray(value.values)) {
      return value.values.map((v: any) => this.parseString(v));
    }
    
    // Handle single string
    const str = this.parseString(value);
    if (str.includes(',')) {
      return str.split(',').map(s => s.trim());
    }
    
    return str ? [str] : [];
  }

  /**
   * Parse number value from decorator
   */
  private static parseNumber(value: any): number {
    const str = this.parseString(value);
    const num = parseFloat(str);
    return isNaN(num) ? 0 : num;
  }

  /**
   * Parse override mappings
   */
  private static parseOverrides(value: any): Record<string, string> {
    const result: Record<string, string> = {};
    
    if (value && value.values && Array.isArray(value.values)) {
      for (const item of value.values) {
        if (item.key && item.val) {
          result[item.key] = this.parseString(item.val);
        }
      }
    }
    
    return result;
  }

  /**
   * Validate decorator combinations
   */
  static validateDecorators(decorators: SchemaStoreDecorators): string[] {
    const errors: string[] = [];

    // Check priority conflicts
    const priorities = [decorators.required, decorators.optional, decorators.suggested].filter(Boolean);
    if (priorities.length > 1) {
      errors.push('Variable can only have one priority: @required, @optional, or @suggested');
    }

    // Check security conflicts
    if (decorators.secret && decorators.public) {
      errors.push('Variable cannot be both @secret and @public');
    }

    // Check type conflicts
    const types = [decorators.number, decorators.boolean, decorators.array, decorators.json].filter(Boolean);
    if (types.length > 1) {
      errors.push('Variable can only have one type: @number, @boolean, @array, or @json');
    }

    // Validate pattern
    if (decorators.pattern) {
      try {
        new RegExp(decorators.pattern);
      } catch {
        errors.push(`Invalid regular expression pattern: ${decorators.pattern}`);
      }
    }

    // Validate version
    if (decorators.version) {
      const semverPattern = /^\^?\d+\.\d+\.\d+$/;
      if (!semverPattern.test(decorators.version)) {
        errors.push(`Invalid version format: ${decorators.version}`);
      }
    }

    // Validate min/max
    if (decorators.min !== undefined && decorators.max !== undefined) {
      if (decorators.min > decorators.max) {
        errors.push(`@min (${decorators.min}) cannot be greater than @max (${decorators.max})`);
      }
    }

    return errors;
  }

  /**
   * Generate TypeScript type from decorators
   */
  static generateType(varName: string, decorators: SchemaStoreDecorators): string {
    let type = 'string';

    if (decorators.number) {
      type = 'number';
    } else if (decorators.boolean) {
      type = 'boolean';
    } else if (decorators.array) {
      type = 'string[]';
    } else if (decorators.json) {
      type = 'any';
    } else if (decorators.enum) {
      type = decorators.enum.map(v => `'${v}'`).join(' | ');
    }

    if (!decorators.required && decorators.optional) {
      type = `${type} | undefined`;
    }

    return `  ${varName}: ${type};`;
  }

  /**
   * Generate validation function from decorators
   */
  static generateValidator(varName: string, decorators: SchemaStoreDecorators): string {
    const checks: string[] = [];

    // Required check
    if (decorators.required) {
      checks.push(`
    if (!value) {
      return { valid: false, error: '${varName} is required' };
    }`);
    }

    // Pattern check
    if (decorators.pattern) {
      checks.push(`
    if (value && !/${decorators.pattern}/.test(value)) {
      return { valid: false, error: '${varName} does not match pattern: ${decorators.pattern}' };
    }`);
    }

    // Enum check
    if (decorators.enum) {
      const enumValues = decorators.enum.map(v => `'${v}'`).join(', ');
      checks.push(`
    if (value && ![${enumValues}].includes(value)) {
      return { valid: false, error: '${varName} must be one of: ${decorators.enum.join(', ')}' };
    }`);
    }

    // Number checks
    if (decorators.number) {
      checks.push(`
    if (value && isNaN(Number(value))) {
      return { valid: false, error: '${varName} must be a number' };
    }`);

      if (decorators.min !== undefined) {
        checks.push(`
    if (value && Number(value) < ${decorators.min}) {
      return { valid: false, error: '${varName} must be at least ${decorators.min}' };
    }`);
      }

      if (decorators.max !== undefined) {
        checks.push(`
    if (value && Number(value) > ${decorators.max}) {
      return { valid: false, error: '${varName} must be at most ${decorators.max}' };
    }`);
      }
    }

    // Boolean check
    if (decorators.boolean) {
      checks.push(`
    if (value && !['true', 'false', '1', '0'].includes(value.toLowerCase())) {
      return { valid: false, error: '${varName} must be a boolean value' };
    }`);
    }

    return `
  validate_${varName}(value: string | undefined) {${checks.join('')}
    return { valid: true };
  }`;
  }
}