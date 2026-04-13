import { expand } from './expand';
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

  get unescapedValue() {
    if (typeof this.value !== 'string') return this.value;
    let unescaped = this.value;
    // replace escaped "$" (if not in single quotes)
    if (this.data.quote !== "'") {
      unescaped = unescaped.replaceAll('\\$', '$');
    }
    // replace escaped newlines (if not double quotes or backticks)
    if (this.data.quote === '"' || this.data.quote === '`') {
      unescaped = unescaped.replaceAll('\\n', '\n');
    }
    return unescaped;
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

export class ParsedEnvSpecRegexLiteral {
  pattern: string;
  flags: string;

  constructor(public data: {
    rawValue: string;
    pattern: string;
    flags: string;
    _location?: any;
  }) {
    this.pattern = data.pattern;
    this.flags = data.flags;
  }

  get value(): RegExp {
    return new RegExp(this.pattern, this.flags);
  }

  toString() {
    return this.data.rawValue;
  }
}

export class ParsedEnvSpecKeyValuePair {
  constructor(public data: {
    key: string;
    val: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecRegexLiteral,
  }) {}

  get key() {
    return this.data.key;
  }

  get value() {
    return this.data.val;
  }

  toString() {
    return `${this.key}=${this.data.val.toString()}`;
  }
}
export class ParsedEnvSpecFunctionArgs {
  constructor(public data: {
    values: Array<
      ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall
      | ParsedEnvSpecKeyValuePair | ParsedEnvSpecRegexLiteral
    >;
    _location?: any;
  }) {}

  get values() {
    return this.data.values;
  }

  get simplifiedValues(): Array<any> | Record<string, any> {
    if (this.data.values.length === 0) return [];
    const vals = this.data.values;
    if (vals.every((i) => i instanceof ParsedEnvSpecStaticValue || i instanceof ParsedEnvSpecRegexLiteral)) {
      return vals.map((val) => val.value);
    } else if (vals.every((i) => i instanceof ParsedEnvSpecKeyValuePair)) {
      const obj = {} as Record<string, any>;
      vals.forEach((val) => {
        if (val.value instanceof ParsedEnvSpecRegexLiteral) {
          obj[val.key] = val.value.value;
        } else if (val.value instanceof ParsedEnvSpecStaticValue) {
          obj[val.key] = val.value.value;
        } else if (val.value instanceof ParsedEnvSpecFunctionCall && val.value.name === 'regex') {
          // Convert regex("pattern") to a RegExp instance (deprecated, prefer /pattern/ literals)
          const args = val.value.simplifiedArgs as Array<any>;
          if (typeof args[0] === 'string') {
            obj[val.key] = new RegExp(args[0]);
          }
        }
      });
      return obj;
    } else {
      throw new Error('Invalid function args');
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
  value?: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall
    | ParsedEnvSpecFunctionArgs | ParsedEnvSpecRegexLiteral;

  constructor(public data: {
    name: string;
    value: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall
      | ParsedEnvSpecFunctionArgs | ParsedEnvSpecRegexLiteral | undefined;
    isBareFnCall?: boolean; // true if decorator is a bare fn call (eg: @import(...))
    _location?: any;
  }) {
    // bare decorator is equivalent to `@decorator=true`
    // `@required` === `@required=true`
    if (!this.data.value) {
      this.value = new ParsedEnvSpecStaticValue({ rawValue: true, isImplicit: true });
    } else if (this.data.value instanceof ParsedEnvSpecRegexLiteral) {
      // regex literals don't need expansion
      this.value = this.data.value;
    } else {
      // process expansion -- triggers $ expansion (eg: "${VAR}" => `ref(VAR)`)/
      const expanded = expand(this.data.value);
      if (expanded instanceof ParsedEnvSpecKeyValuePair) {
        throw new Error('Unexpected key-value pair found in config item');
      }
      this.value = expanded;
    }
  }

  get name() {
    return this.data.name;
  }
  get isBareFnCall() {
    return !!this.data.isBareFnCall;
  }
  get bareFnArgs() {
    if (this.isBareFnCall && this.value instanceof ParsedEnvSpecFunctionArgs) {
      return this.value;
    }
  }

  get simplifiedValue() {
    if (this.value instanceof ParsedEnvSpecStaticValue) {
      return this.value.value;
    }
  }
  toString() {
    let s = `@${this.name}`;
    if (!this.data.value) return s; // bare decorator, ex: `@required`
    // bare fn call looks like `@import(asdf)` so no `=`
    if (!this.isBareFnCall) s += '=';
    // let the value stringify itself
    s += this.data.value.toString();
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

function getDecoratorsArray(
  comments: Array<ParsedEnvSpecDecoratorComment | ParsedEnvSpecComment | undefined>,
) {
  const decArr = [] as Array<ParsedEnvSpecDecorator>;
  comments.forEach((comment) => {
    if (comment instanceof ParsedEnvSpecDecoratorComment) {
      decArr.push(...comment.decorators);
    }
  });
  return decArr;
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
  get decoratorsArray() {
    return getDecoratorsArray(this.data.comments);
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
  value: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecRegexLiteral | undefined;

  constructor(public data: {
    key: string;
    value: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecRegexLiteral | undefined;
    preComments: Array<ParsedEnvSpecDecoratorComment | ParsedEnvSpecComment>;
    postComment: ParsedEnvSpecDecoratorComment | ParsedEnvSpecComment | undefined;
    _location?: any;
  }) {
    if (this.data.value) {
      // regex literals don't need expansion
      if (this.data.value instanceof ParsedEnvSpecRegexLiteral) {
        this.value = this.data.value;
      } else {
        const expanded = expand(this.data.value!);
        if (expanded instanceof ParsedEnvSpecKeyValuePair) {
          throw new Error('Nested key-value pair found in config item');
        } else if (expanded instanceof ParsedEnvSpecFunctionArgs) {
          throw new Error('Top-level config item cannot be a bare function args');
        }
        this.value = expanded;
      }
    }
  }

  get key() {
    return this.data.key;
  }

  get decoratorsArray() {
    return getDecoratorsArray([...this.data.preComments, this.data.postComment]);
  }

  get decoratorsObject() {
    return getDecoratorsObject([...this.data.preComments, this.data.postComment]);
  }

  get description() {
    const regularComments = this.data.preComments.filter((comment) => (comment instanceof ParsedEnvSpecComment));
    return regularComments.map((comment) => comment.contents).join('\n');
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
type ParsedEnvSpecFileNode = ParsedEnvSpecCommentBlock
  | ParsedEnvSpecDivider
  | ParsedEnvSpecConfigItem
  | ParsedEnvSpecBlankLine;


export class ParsedEnvSpecFile {
  contents: Array<ParsedEnvSpecFileNode>;
  constructor(_contents: Array<ParsedEnvSpecFileNode>) {
    this.contents = _contents;
  }

  get configItems() {
    return this.contents.filter((item) => item instanceof ParsedEnvSpecConfigItem);
  }
  /** all comment blocks before the first config item (the "header" area) */
  get headerBlocks() {
    const blocks: Array<ParsedEnvSpecCommentBlock> = [];
    for (const item of this.contents) {
      if (item instanceof ParsedEnvSpecCommentBlock) {
        blocks.push(item);
      } else if (item instanceof ParsedEnvSpecBlankLine || item instanceof ParsedEnvSpecDivider) {
        continue;
      } else {
        break; // hit a config item
      }
    }
    return blocks;
  }
  /** primary header block - the last comment block before the first config item */
  get header() {
    const blocks = this.headerBlocks;
    return blocks.length > 0 ? blocks[blocks.length - 1] : undefined;
  }
  get decoratorsObject() {
    const decObj = {} as Record<string, ParsedEnvSpecDecorator>;
    for (const block of this.headerBlocks) {
      Object.assign(decObj, block.decoratorsObject);
    }
    return decObj;
  }
  get decoratorsArray() {
    const decArr: Array<ParsedEnvSpecDecorator> = [];
    for (const block of this.headerBlocks) {
      decArr.push(...block.decoratorsArray);
    }
    return decArr;
  }

  /**
   * Comment blocks that are NOT part of the header and NOT attached to a config item.
   * Any decorators in these blocks are misplaced.
   */
  get orphanCommentBlocks() {
    const headerBlockSet = new Set(this.headerBlocks);
    return this.contents.filter(
      (item): item is ParsedEnvSpecCommentBlock => (
        item instanceof ParsedEnvSpecCommentBlock && !headerBlockSet.has(item)
      ),
    );
  }

  toString() {
    return this.contents.map((item) => item.toString()).join('\n');
  }
  /**
   * simple helper to convert an object in a basic case
   * mostly useful for comparison with other env parsers
   * */
  toSimpleObj() {
    const obj = {} as Record<string, any>;
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
