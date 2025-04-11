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
    _location: any;
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

export class ParsedEnvSpecFunctionCall {
  constructor(private data: {
    name: string;
    args: Array<ParsedEnvSpecStaticValue> | Array<{ key: string, val: ParsedEnvSpecStaticValue }>;
    _location: any;
  }) {}

  get name() {
    return this.data.name;
  }

  get argsValue() {
    // `fn()` -- no args passed is equivalent to an empty array or args
    if (!this.data.args) {
      return [];
    // `fn(k1=v1, k2=v2)` -- args are an array of key=value pairs, which we'll convert to an object
    } else if ('key' in this.data.args[0]) {
      const obj = {};
      this.data.args.forEach((arg) => {
        obj[arg.key] = arg.val.value;
      });
      return obj;
    // `fn(v1, v2)` -- args are an array of values, which we'll just map to an array
    } else {
      return this.data.args.map((arg) => arg.value);
    }
  }
}


export class ParsedEnvSpecDecorator {
  constructor(private data: {
    name: string;
    value: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | undefined;
    _location: any;
  }) {}

  get name() {
    return this.data.name;
  }

  // SIMILAR TO CONFIG ITEM
  // might want to refactor to clean this up a bit - it's a little clunky

  get valueIsStatic() {
    // no value is equivalent to static `true` ex: `@required`
    if (!this.data.value) return true;
    return this.data.value instanceof ParsedEnvSpecStaticValue;
  }

  get valueIsFunctionCall() {
    return this.data.value instanceof ParsedEnvSpecFunctionCall;
  }

  get staticValue() {
    // no value is equivalent to static `true` ex: `@required`
    if (!this.data.value) {
      return true;
    } else if (this.data.value instanceof ParsedEnvSpecStaticValue) {
      return this.data.value.value;
    } else {
      throw new Error('Value is not a static value');
    }
  }

  get functionCall() {
    if (this.data.value instanceof ParsedEnvSpecFunctionCall) {
      return this.data.value;
    } else {
      throw new Error('Value is not a function call');
    }
  }
}


export class ParsedEnvSpecComment {
  constructor(private data: {
    contents: string;
    _location: any;
  }) {}
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
    postComment: ParsedEnvSpecDecoratorComment | ParsedEnvSpecComment;
    _location: any;
  }) {}


  get valueIsStatic() {
    if (!this.data.value) return true; // no value is equivalent to static `undefined`
    return this.data.value instanceof ParsedEnvSpecStaticValue;
  }

  get valueIsFunctionCall() {
    return this.data.value instanceof ParsedEnvSpecFunctionCall;
  }

  get staticValue() {
    if (!this.data.value) {
      return undefined;
    } else if (this.data.value instanceof ParsedEnvSpecStaticValue) {
      return this.data.value.value;
    } else {
      throw new Error('Value is not a static value');
    }
  }

  get functionCall() {
    if (this.data.value instanceof ParsedEnvSpecFunctionCall) {
      return this.data.value;
    } else {
      throw new Error('Value is not a function call');
    }
  }

  get decoratorsObject() {
    const decObj = {};
    [...this.data.preComments, this.data.postComment].forEach((comment) => {
      if (!comment) return;
      if (comment instanceof ParsedEnvSpecDecoratorComment) {
        comment.decorators.forEach((decorator) => {
          if (decorator.valueIsStatic) {
            // only adding static values for now
            decObj[decorator.name] = decorator.staticValue;
          }
        });
      }
    });
    return decObj;
  }
}

export class ParsedEnvSpecFile {
  contents: any;
  constructor(_contents: any) {
    this.contents = _contents;
  }

  get configItems() {
    return this.contents.filter((item) => item instanceof ParsedEnvSpecConfigItem);
  }
}
