import { autoCoerce } from './helpers';


export class ParsedEnvSpecCommentLine {

}
export class ParsedEnvSpecDivider {
  constructor(private data: {
    contents: string;
    _location: any;
  }) {}
}


export class ParsedEnvSpecStaticValue {
  value: any;

  constructor(private data: {
    rawValue: any;
    quote?: '"' | "'" | '`' | undefined;
    isImplicit?: boolean;
    _location?: any;
  }) {
    if (!data.quote) {
      this.value = autoCoerce(this.data.rawValue);
    } else {
      const quoteChar = data.quote.substring(0, 1);
      this.value = data.rawValue
        .slice(data.quote.length, -1 * data.quote.length)
        .replaceAll(`\\${quoteChar}`, quoteChar);
    }
  }
}

export class ParsedEnvSpecKeyValuePair {
  constructor(private data: {
    key: string;
    val: ParsedEnvSpecStaticValue;
  }) {}

  get key() {
    return this.data.key;
  }

  get value() {
    return this.data.val.value;
  }
}
export class ParsedEnvSpecFunctionArgs {
  constructor(private data: {
    values: Array<ParsedEnvSpecStaticValue> | Array<ParsedEnvSpecKeyValuePair>;
    _location: any;
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
}

export class ParsedEnvSpecFunctionCall {
  constructor(private data: {
    name: string;
    args: ParsedEnvSpecFunctionArgs;
    _location: any;
  }) {}

  get name() {
    return this.data.name;
  }
  get simplifiedArgs() {
    return this.data.args.simplifiedValues;
  }
}


export class ParsedEnvSpecDecorator {
  constructor(private data: {
    name: string;
    valueOrFnArgs: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecFunctionArgs | undefined;
    _location: any;
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
}


export class ParsedEnvSpecComment {
  constructor(private data: {
    contents: string;
    _location: any;
  }) {}

  get contents() {
    return this.data.contents;
  }
}
export class ParsedEnvSpecDecoratorComment {
  constructor(private data: {
    decorators: Array<ParsedEnvSpecDecorator>;
    postComment: any;
    _location: any;
  }) {}

  get decorators() {
    return this.data.decorators;
  }

  get postComment() {
    return this.data.postComment;
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
  constructor(private data: {
    comments: Array<ParsedEnvSpecDecoratorComment | ParsedEnvSpecComment>;
    divider: ParsedEnvSpecDivider | null;
    _location: any;
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
}

export class ParsedEnvSpecBlankLine {
  constructor(private data: {
    _location: any;
  }) {}
}


export class ParsedEnvSpecConfigItem {
  constructor(private data: {
    key: string;
    value: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | undefined;
    preComments: Array<ParsedEnvSpecDecoratorComment | ParsedEnvSpecComment>;
    postComment: ParsedEnvSpecDecoratorComment | ParsedEnvSpecComment | undefined;
    _location: any;
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
}
