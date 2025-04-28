import { autoCoerce } from './helpers';

export class ParsedEnvSpecDivider {
  constructor(public data: {
    contents: string;
    leadingSpace?: string;
    _location?: any;
  }) {}

  toString() {
    return `#${this.data.leadingSpace || ''}${this.data.contents}`;
  }
}

export class ParsedEnvSpecStaticValue {
  value: any;

  constructor(public data: {
    rawValue: any;
    quote?: '"' | "'" | '`' | undefined;
    isImplicit?: boolean;
    _location?: any;
  }) {
    if (!data.quote) {
      // unquoted strings will get trimmed (leading/trailing spaces)
      if (typeof data.rawValue === 'string') {
        const trimmed = data.rawValue.trim();
        // trimmed empty string without quotes gets treated as undefined
        if (trimmed === '') this.value = undefined;
        else this.value = autoCoerce(trimmed);
      } else {
        this.value = autoCoerce(data.rawValue);
      }
    } else {
      const quoteChar = data.quote.substring(0, 1);
      this.value = data.rawValue
        .slice(data.quote.length, -1 * data.quote.length)
        .replaceAll(`\\${quoteChar}`, quoteChar);
    }
  }

  toString() {
    // TODO: smarter logic to preserve the original value
    // for example with this logic, we may see 123.0 -> 123
    let strVal = String(this.value);
    if (this.data.quote) {
      strVal = strVal.replaceAll(this.data.quote, `\\${this.data.quote}`);
    }
    return `${this.data.quote || ''}${strVal}${this.data.quote || ''}`;
  }
}

export class ParsedEnvSpecKeyValuePair {
  constructor(public data: {
    key: string;
    val: ParsedEnvSpecStaticValue;
  }) {}

  get key() {
    return this.data.key;
  }

  get value() {
    return this.data.val.value;
  }

  toString() {
    return `${this.key}=${this.data.val}`;
  }
}
export class ParsedEnvSpecFunctionArgs {
  constructor(public data: {
    values: Array<ParsedEnvSpecStaticValue> | Array<ParsedEnvSpecKeyValuePair>;
    _location?: any;
  }) {}

  get values() {
    return this.data.values;
  }

  get simplifiedValues(): Array<any> | Record<string, any> {
    if (this.data.values.length === 0) {
      return [];
    } else if (this.data.values[0] instanceof ParsedEnvSpecStaticValue) {
      return this.data.values.map((val) => val.value);
    } else {
      const obj = {};
      this.data.values.forEach((val) => {
        obj[val.key] = val.value;
      });
      return obj;
    }
  }

  toString() {
    let s = '(';
    s += this.data.values.map((val) => val.toString()).join(', ');
    s += ')';
    return s;
  }
}

export class ParsedEnvSpecFunctionCall {
  constructor(public data: {
    name: string;
    args: ParsedEnvSpecFunctionArgs;
    _location?: any;
  }) {}

  get name() {
    return this.data.name;
  }
  get simplifiedArgs() {
    return this.data.args.simplifiedValues;
  }

  toString() {
    // args will include the `()`
    return this.data.name + this.data.args.toString();
  }
}


export class ParsedEnvSpecDecorator {
  constructor(public data: {
    name: string;
    valueOrFnArgs: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecFunctionArgs | undefined;
    _location?: any;
  }) {
  }

  get name() {
    return this.data.name;
  }

  get bareFnArgs() {
    if (this.data.valueOrFnArgs && this.data.valueOrFnArgs instanceof ParsedEnvSpecFunctionArgs) {
      return this.data.valueOrFnArgs;
    }
  }

  get value() {
    // bare decorator is equivalent to `@decorator=true`
    // `@required` === `@required=true`
    if (!this.data.valueOrFnArgs) {
      return new ParsedEnvSpecStaticValue({ rawValue: true, isImplicit: true });
    } else if (!(this.data.valueOrFnArgs instanceof ParsedEnvSpecFunctionArgs)) {
      return this.data.valueOrFnArgs;
    }
  }
  get simplifiedValue() {
    if (this.value instanceof ParsedEnvSpecStaticValue) {
      return this.value.value;
    }
  }

  toString() {
    let s = `@${this.name}`;
    if (!this.data.valueOrFnArgs) return s; // bare decorator, ex: `@required`
    // bare fn call looks like `@import(asdf)` so no `=`
    if (!(this.data.valueOrFnArgs instanceof ParsedEnvSpecFunctionArgs)) s += '=';
    // let the value stringify itself
    s += this.data.valueOrFnArgs.toString();
    return s;
  }
}


export class ParsedEnvSpecComment {
  constructor(public data: {
    contents: string;
    leadingSpace?: string;
    _location?: any;
  }) {}

  get contents() {
    return this.data.contents;
  }

  toString() {
    return `#${this.data.leadingSpace || ''}${this.data.contents}`;
  }
}
export class ParsedEnvSpecDecoratorComment {
  constructor(public data: {
    decorators: Array<ParsedEnvSpecDecorator>;
    leadingSpace?: string;
    postComment?: any;
    _location?: any;
  }) {}

  get decorators() {
    return this.data.decorators;
  }

  get postComment() {
    return this.data.postComment;
  }

  toString() {
    let s = '#';
    s += this.data.leadingSpace || '';
    s += this.data.decorators.map((d) => d.toString()).join(' ');
    if (this.data.postComment) s += ` ${this.data.postComment.toString()}`;
    return s;
  }
}

export type ParsedEnvSpecDecoratorValue =
  ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecFunctionArgs;

function getDecoratorsObject(
  comments: Array<ParsedEnvSpecDecoratorComment | ParsedEnvSpecComment | undefined>,
) {
  const decObj = {} as Record<string, ParsedEnvSpecDecorator>;
  comments.forEach((comment) => {
    if (comment instanceof ParsedEnvSpecDecoratorComment) {
      comment.decorators.forEach((decorator) => {
        decObj[decorator.name] = decorator;
      });
    }
  });
  return decObj;
}

export class ParsedEnvSpecCommentBlock {
  constructor(public data: {
    comments: Array<ParsedEnvSpecDecoratorComment | ParsedEnvSpecComment>;
    divider: ParsedEnvSpecDivider | null;
    _location?: any;
  }) {}

  get comments() {
    return this.data.comments;
  }

  get divider() {
    return this.data.divider || undefined;
  }

  get decoratorsObject() {
    return getDecoratorsObject(this.data.comments);
  }

  toString() {
    return [
      ...this.data.comments.map((comment) => comment.toString()),
      ...this.data.divider ? [this.data.divider.toString()] : [],
    ].join('\n');
  }
}

export class ParsedEnvSpecBlankLine {
  constructor(public data: {
    _location?: any;
  }) {}

  toString() {
    return '';
  }
}


export class ParsedEnvSpecConfigItem {
  constructor(public data: {
    key: string;
    value: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | undefined;
    preComments: Array<ParsedEnvSpecDecoratorComment | ParsedEnvSpecComment>;
    postComment: ParsedEnvSpecDecoratorComment | ParsedEnvSpecComment | undefined;
    _location?: any;
  }) {}

  get key() {
    return this.data.key;
  }
  get value() {
    // no value is equivalent to `undefined`
    // `ITEM=` === `ITEM=undefined`
    if (!this.data.value) {
      return new ParsedEnvSpecStaticValue({ rawValue: undefined, isImplicit: true });
    }
    return this.data.value;
  }

  get decoratorsObject() {
    return getDecoratorsObject([...this.data.preComments, this.data.postComment]);
  }

  get description() {
    const regularComments = this.data.preComments.filter((comment) => (comment instanceof ParsedEnvSpecComment));
    return regularComments.map((comment) => comment.contents).join('\n');
  }

  toConfigItemDef() {
    return {
      key: this.key,
      valueResolver: this.resolverDef,
      description: this.description,
      decorators: this.decoratorsObject,
    };
  }

  private get resolverDef() {
    if (!this.data.value) {
      return {
        type: 'static' as const,
        value: undefined,
      };
    } else if (this.data.value instanceof ParsedEnvSpecStaticValue) {
      return {
        type: 'static' as const,
        value: this.data.value.value,
      };
    } else if (this.data.value instanceof ParsedEnvSpecFunctionCall) {
      return {
        type: 'function' as const,
        functionName: this.data.value.name,
        functionArgs: this.data.value.simplifiedArgs,
      };
    } else {
      throw new Error('Unknown value resolver type');
    }
  }

  toString() {
    let s = '';
    for (const comment of this.data.preComments) s += `${comment.toString()}\n`;
    s += `${this.key}=`;
    if (this.data.value) s += `${this.data.value.toString()}`;
    if (this.data.postComment) s += ` ${this.data.postComment.toString()}`;
    return s;
  }
}

// these are the 4 types that can be at the root level
type ParsedEnvSpecFileNode =
  ParsedEnvSpecCommentBlock |
  ParsedEnvSpecDivider |
  ParsedEnvSpecConfigItem |
  ParsedEnvSpecBlankLine;


export class ParsedEnvSpecFile {
  contents: Array<ParsedEnvSpecFileNode>;
  constructor(_contents: Array<ParsedEnvSpecFileNode>) {
    this.contents = _contents;
  }

  get configItems() {
    return this.contents.filter((item) => item instanceof ParsedEnvSpecConfigItem);
  }
  get header() {
    // header is a comment block at the the start of the file
    // it may be preceeded by blank lines only
    for (const item of this.contents) {
      if (item instanceof ParsedEnvSpecCommentBlock) {
        return item;
      } else if (!(item instanceof ParsedEnvSpecBlankLine)) {
        return;
      }
    }
  }
  get decoratorsObject() {
    return this.header?.decoratorsObject ?? {};
  }

  toString() {
    return this.contents.map((item) => item.toString()).join('\n');
  }
  /**
   * simple helper to convert an object in a basic case
   * mostly useful for comparison with other env parsers
   * */
  toSimpleObj() {
    const obj = {};
    for (const item of this.contents) {
      if (item instanceof ParsedEnvSpecConfigItem) {
        if (item.value instanceof ParsedEnvSpecStaticValue) {
          obj[item.key] = item.value.value ?? '';
        }
      }
    }
    return obj;
  }
}
