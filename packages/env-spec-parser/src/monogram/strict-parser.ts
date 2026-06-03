import {
  ParsedEnvSpecBlankLine,
  ParsedEnvSpecComment,
  ParsedEnvSpecCommentBlock,
  ParsedEnvSpecConfigItem,
  ParsedEnvSpecDecorator,
  ParsedEnvSpecDecoratorComment,
  ParsedEnvSpecDivider,
  ParsedEnvSpecFile,
  ParsedEnvSpecFunctionArgs,
  ParsedEnvSpecFunctionCall,
  ParsedEnvSpecKeyValuePair,
  ParsedEnvSpecStaticValue,
} from '../classes';

type ParsedValueNode = ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall;

type ParsedCommentNode = ParsedEnvSpecDecoratorComment | ParsedEnvSpecComment;

class StrictParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parseFile(): ParsedEnvSpecFile {
    const nodes: Array<
      ParsedEnvSpecCommentBlock | ParsedEnvSpecDivider | ParsedEnvSpecConfigItem | ParsedEnvSpecBlankLine
    > = [];
    while (!this.isEof()) {
      const node = this.parseTopLevelNode();
      if (!node) {
        this.throwParseError('Unexpected token at top level');
      }
      nodes.push(node);
    }
    return new ParsedEnvSpecFile(nodes);
  }

  private parseTopLevelNode() {
    const config = this.tryParseConfigItem();
    if (config) return config;

    const divider = this.tryParseDivider();
    if (divider) return divider;

    const commentBlock = this.tryParseCommentBlock();
    if (commentBlock) return commentBlock;

    const blank = this.tryParseBlankLine();
    if (blank) return blank;

    return undefined;
  }

  private tryParseConfigItem(): ParsedEnvSpecConfigItem | undefined {
    return this.attempt(() => {
      const preComments: Array<ParsedCommentNode> = [];
      while (true) {
        const comment = this.tryParseDecoratorComment() ?? this.tryParseComment();
        if (!comment) break;
        this.parseNewline();
        preComments.push(comment);
      }

      this.parseWs();
      const exportStart = this.index;
      if (this.consumeLiteral('export ')) {
        this.parseWs();
      } else {
        this.index = exportStart;
      }

      this.parseWs();
      const key = this.parseConfigItemKey();
      this.parseWs();
      this.expectChar('=');

      let value: ParsedValueNode | undefined;
      const valueAttempt = this.attempt(() => this.parseConfigItemValue());
      if (valueAttempt) value = valueAttempt;

      this.parseWs();
      const postComment = this.tryParseDecoratorComment() ?? this.tryParseComment();
      this.parseWs();
      this.parseNewline();

      return new ParsedEnvSpecConfigItem({
        key,
        value,
        preComments,
        postComment,
      });
    });
  }

  private tryParseCommentBlock(): ParsedEnvSpecCommentBlock | undefined {
    return this.attempt(() => {
      const comments: Array<ParsedCommentNode> = [];
      while (true) {
        const comment = this.tryParseDecoratorComment() ?? this.tryParseComment();
        if (!comment) break;
        this.parseNewline();
        comments.push(comment);
      }
      if (comments.length === 0) this.throwParseError('Expected at least one comment for comment block');

      const divider = this.tryParseDivider();
      if (divider) {
        return new ParsedEnvSpecCommentBlock({ comments, divider });
      }

      this.parseNewline();
      return new ParsedEnvSpecCommentBlock({ comments, divider: null });
    });
  }

  private tryParseBlankLine(): ParsedEnvSpecBlankLine | undefined {
    return this.attempt(() => {
      this.expectChar('\n');
      return new ParsedEnvSpecBlankLine({});
    });
  }

  private tryParseDivider(): ParsedEnvSpecDivider | undefined {
    return this.attempt(() => {
      this.expectChar('#');
      const leadingSpace = this.readWhile((ch) => ch === ' ' || ch === '\t');
      const marker = this.readWhile((ch) => ch === '-' || ch === '=' || ch === '*' || ch === '#');
      if (marker.length < 3) {
        this.throwParseError('Expected divider marker');
      }
      const rest = this.readUntilNewline();
      this.parseNewline();
      return new ParsedEnvSpecDivider({
        contents: marker + rest,
        leadingSpace,
      });
    });
  }

  private tryParseComment(): ParsedEnvSpecComment | undefined {
    return this.attempt(() => {
      if (this.looksLikeDivider()) this.throwParseError('Divider is not a comment');
      this.expectChar('#');
      const leadingSpace = this.readWhile((ch) => ch === ' ' || ch === '\t');
      if (this.peek() === '@') this.throwParseError('Decorator comment is not a plain comment');
      const contents = this.readUntilNewline();
      return new ParsedEnvSpecComment({ contents, leadingSpace });
    });
  }

  private tryParseDecoratorComment(): ParsedEnvSpecDecoratorComment | undefined {
    return this.attempt(() => {
      this.expectChar('#');
      const leadingSpace = this.readWhile((ch) => ch === ' ' || ch === '\t');
      if (this.peek() !== '@') this.throwParseError('Not a decorator comment');

      const first = this.parseDecorator();
      const allDecorators = [first];
      let lastDecorator = first;

      while (true) {
        const whitespace = this.readRequiredWs();
        if (!whitespace) break;

        const postCommentStart = this.index;
        if (this.peek() === '#') {
          this.index = postCommentStart;
          break;
        }

        const decorator = this.tryParseDecoratorCommentDecoratorOrText();
        if (!decorator) {
          this.index = postCommentStart;
          break;
        }

        if (decorator instanceof ParsedEnvSpecDecorator) {
          allDecorators.push(decorator);
          lastDecorator = decorator;
        } else {
          lastDecorator.data.strayText = decorator;
        }
      }

      const postCommentStart = this.index;
      this.parseWs();
      let postComment: string | undefined;
      if (this.peek() === '#') {
        postComment = this.readUntilNewline();
      } else {
        this.index = postCommentStart;
      }

      this.parseWs();
      return new ParsedEnvSpecDecoratorComment({
        decorators: allDecorators,
        leadingSpace,
        postComment,
      });
    });
  }

  private tryParseDecoratorCommentDecoratorOrText(): ParsedEnvSpecDecorator | string | undefined {
    const dec = this.tryParseDecorator();
    if (dec) return dec;

    return this.attempt(() => {
      const firstChar = this.peek();
      if (!firstChar || firstChar === ' ' || firstChar === '\t' || firstChar === '@' || firstChar === '#' || firstChar === '\n') {
        this.throwParseError('Decorator text does not start with a valid char');
      }

      let first = this.readOne();
      first += this.readWhile((ch) => ch !== ' ' && ch !== '\t' && ch !== '@' && ch !== '\n');
      const rest: Array<string> = [];

      while (true) {
        const whitespace = this.readRequiredWs();
        if (!whitespace) break;

        const ch = this.peek();
        if (!ch || ch === ' ' || ch === '\t' || ch === '@' || ch === '#' || ch === '\n') {
          this.index -= whitespace.length;
          break;
        }

        let part = this.readOne();
        part += this.readWhile((c) => c !== ' ' && c !== '\t' && c !== '@' && c !== '\n');
        rest.push(part);
      }

      return [first, ...rest].join(' ');
    });
  }

  private tryParseDecorator(): ParsedEnvSpecDecorator | undefined {
    return this.attempt(() => this.parseDecorator());
  }

  private parseDecorator(): ParsedEnvSpecDecorator {
    this.expectChar('@');
    const name = this.parseDecoratorName();

    let value: ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecFunctionArgs | undefined;
    let isBareFnCall = false;

    if (this.peek() === '(') {
      value = this.parseFunctionArgs('decorator');
      isBareFnCall = true;
    } else if (this.consumeLiteral('=')) {
      value = this.parseDecoratorValue();
    }

    return new ParsedEnvSpecDecorator({
      name,
      value,
      isBareFnCall,
    });
  }

  private parseDecoratorName(): string {
    const first = this.peek();
    if (!first || !/[a-zA-Z]/.test(first)) {
      this.throwParseError('Decorator name must start with a letter');
    }

    let name = this.readOne();
    name += this.readWhile((ch) => ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '=' && ch !== '(' && ch !== ')' && ch !== '#' && ch !== '@');
    return name;
  }

  private parseDecoratorValue(): ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall {
    const fn = this.tryParseDecoratorFunctionCall();
    if (fn) return fn;

    const quoted = this.tryParseQuotedString();
    if (quoted) return quoted;

    const first = this.peek();
    if (first === '"' || first === "'" || first === '`') {
      this.throwParseError('Unterminated quoted decorator value');
    }

    const raw = this.readWhile((ch) => ch !== '#' && ch !== ' ' && ch !== '\n');
    if (!raw) this.throwParseError('Expected decorator value');
    return new ParsedEnvSpecStaticValue({ rawValue: raw });
  }

  private tryParseDecoratorFunctionCall(): ParsedEnvSpecFunctionCall | undefined {
    return this.attempt(() => {
      const name = this.parseFunctionName();
      const args = this.parseFunctionArgs('decorator');
      return new ParsedEnvSpecFunctionCall({ name, args });
    });
  }

  private parseConfigItemValue(): ParsedValueNode {
    const fn = this.tryParseFunctionCall();
    if (fn) return fn;

    const multiLineString = this.tryParseMultiLineString();
    if (multiLineString) return multiLineString;

    const quoted = this.tryParseQuotedString();
    if (quoted) return quoted;

    const start = this.index;
    const ws = this.readWhile((ch) => ch === ' ' || ch === '\t');
    const first = this.peek();
    if (first === '"' || first === "'" || first === '`') {
      this.index = start;
      this.throwParseError('Unquoted value cannot start with a quote');
    }

    const rest = this.readWhile((ch) => ch !== '#' && ch !== '\n');
    if (!rest) {
      this.index = start;
      this.throwParseError('Expected config value');
    }

    return new ParsedEnvSpecStaticValue({ rawValue: ws + rest });
  }

  private tryParseFunctionCall(): ParsedEnvSpecFunctionCall | undefined {
    return this.attempt(() => {
      const name = this.parseFunctionName();
      const args = this.parseFunctionArgs('value');
      return new ParsedEnvSpecFunctionCall({ name, args });
    });
  }

  private parseFunctionName(): string {
    const first = this.peek();
    if (!first || !/[a-zA-Z]/.test(first)) {
      this.throwParseError('Function name must start with a letter');
    }

    let name = this.readOne();
    name += this.readWhile((ch) => /[a-zA-Z0-9_]/.test(ch));
    return name;
  }

  private parseFunctionArgs(mode: 'decorator' | 'value'): ParsedEnvSpecFunctionArgs {
    this.expectChar('(');
    this.parseArgsWs(mode);

    const values: Array<ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall | ParsedEnvSpecKeyValuePair> = [];
    let parsedAny = false;

    while (this.peek() !== ')') {
      const value = this.parseFunctionArg(mode);
      values.push(value);
      parsedAny = true;

      this.parseArgsWs(mode);
      if (!this.consumeLiteral(',')) break;
      this.parseArgsWs(mode);
    }

    if (parsedAny) {
      const trailingMark = this.index;
      this.parseArgsWs(mode);
      if (!this.consumeLiteral(',')) {
        this.index = trailingMark;
      }
    }

    this.parseArgsWs(mode);
    this.expectChar(')');

    return new ParsedEnvSpecFunctionArgs({ values });
  }

  private parseFunctionArg(mode: 'decorator' | 'value') {
    const keyValue = this.tryParseFunctionKeyValue(mode);
    if (keyValue) return keyValue;

    return this.parseFunctionArgValue(mode);
  }

  private tryParseFunctionKeyValue(mode: 'decorator' | 'value'): ParsedEnvSpecKeyValuePair | undefined {
    return this.attempt(() => {
      const key = this.parseFunctionArgKeyName();
      this.expectChar('=');
      const val = this.parseFunctionArgValue(mode);
      return new ParsedEnvSpecKeyValuePair({ key, val });
    });
  }

  private parseFunctionArgKeyName(): string {
    const first = this.peek();
    if (!first || !/[a-zA-Z]/.test(first)) {
      this.throwParseError('Function arg key must start with a letter');
    }

    let name = this.readOne();
    name += this.readWhile((ch) => /[a-zA-Z0-9_]/.test(ch));
    return name;
  }

  private parseFunctionArgValue(mode: 'decorator' | 'value'): ParsedEnvSpecStaticValue | ParsedEnvSpecFunctionCall {
    if (mode === 'decorator') {
      const nested = this.tryParseDecoratorFunctionCall();
      if (nested) return nested;
    } else {
      const nested = this.tryParseFunctionCall();
      if (nested) return nested;
    }

    const quoted = this.tryParseQuotedString();
    if (quoted) return quoted;

    const raw = this.readWhile((ch) => ch !== ' ' && ch !== '\n' && ch !== ',' && ch !== ')');
    if (!raw) this.throwParseError('Expected function arg value');
    return new ParsedEnvSpecStaticValue({ rawValue: raw });
  }

  private parseArgsWs(mode: 'decorator' | 'value') {
    if (mode === 'value') {
      this.readWhile((ch) => ch === ' ' || ch === '\t' || ch === '\n');
      return;
    }

    while (true) {
      const ws = this.readWhile((ch) => ch === ' ' || ch === '\t');
      if (ws) continue;

      if (this.peek() !== '\n') break;
      const save = this.index;
      this.index += 1;
      this.readWhile((ch) => ch === ' ' || ch === '\t');
      if (this.peek() !== '#') {
        this.index = save;
        break;
      }
      this.index += 1;
      this.readWhile((ch) => ch === ' ' || ch === '\t');
    }
  }

  private tryParseMultiLineString(): ParsedEnvSpecStaticValue | undefined {
    return this.tryParseTripleMultiLineString('"""')
      ?? this.tryParseTripleMultiLineString('```')
      ?? this.tryParseSingleQuoteMultiLineString("'")
      ?? this.tryParseSingleQuoteMultiLineString('"');
  }

  private tryParseSingleQuoteMultiLineString(quote: '"' | "'"): ParsedEnvSpecStaticValue | undefined {
    return this.attempt(() => {
      if (this.peek() !== quote) this.throwParseError('Expected multiline quote start');
      const start = this.index;
      this.index += 1;

      let hadNewline = false;
      while (!this.isEof()) {
        const ch = this.readOne();
        if (ch === '\n') hadNewline = true;
        if (ch === '\\') {
          if (!this.isEof()) this.index += 1;
          continue;
        }
        if (ch === quote) {
          if (!hadNewline) {
            this.index = start;
            this.throwParseError('Expected multiline string to contain newline');
          }
          const rawValue = this.source.slice(start, this.index);
          return new ParsedEnvSpecStaticValue({ rawValue, quote: quote as any });
        }
      }

      this.index = start;
      this.throwParseError('Unterminated multiline string');
    });
  }

  private tryParseTripleMultiLineString(quote: '"""' | '```'): ParsedEnvSpecStaticValue | undefined {
    return this.attempt(() => {
      if (!this.consumeLiteral(quote)) this.throwParseError('Expected triple quote');
      const start = this.index - quote.length;
      let hadNewline = false;

      while (!this.isEof()) {
        if (this.consumeLiteral(`\\${quote}`)) continue;
        if (this.peek() === '\n') hadNewline = true;
        if (this.consumeLiteral(quote)) {
          if (!hadNewline) {
            this.index = start;
            this.throwParseError('Expected triple quoted string to contain newline');
          }
          const rawValue = this.source.slice(start, this.index);
          return new ParsedEnvSpecStaticValue({ rawValue, quote: quote as any });
        }
        this.index += 1;
      }

      this.index = start;
      this.throwParseError('Unterminated triple quoted string');
    });
  }

  private tryParseQuotedString(): ParsedEnvSpecStaticValue | undefined {
    return this.tryParseSingleLineQuotedString('"')
      ?? this.tryParseSingleLineQuotedString("'")
      ?? this.tryParseSingleLineQuotedString('`');
  }

  private tryParseSingleLineQuotedString(quote: '"' | "'" | '`'): ParsedEnvSpecStaticValue | undefined {
    return this.attempt(() => {
      if (this.peek() !== quote) this.throwParseError('Expected quote');
      const start = this.index;
      this.index += 1;

      while (!this.isEof()) {
        const ch = this.readOne();
        if (ch === '\n') {
          this.index = start;
          this.throwParseError('Quoted string cannot contain newline');
        }
        if (ch === '\\') {
          if (!this.isEof()) this.index += 1;
          continue;
        }
        if (ch === quote) {
          const rawValue = this.source.slice(start, this.index);
          return new ParsedEnvSpecStaticValue({ rawValue, quote });
        }
      }

      this.index = start;
      this.throwParseError('Unterminated quoted string');
    });
  }

  private parseConfigItemKey(): string {
    const first = this.peek();
    if (!first || !/[a-zA-Z_]/.test(first)) {
      this.throwParseError('Config key must start with a letter or underscore');
    }

    let key = this.readOne();
    key += this.readWhile((ch) => /[a-zA-Z0-9_.-]/.test(ch));
    return key;
  }

  private looksLikeDivider(): boolean {
    const save = this.index;
    if (this.peek() !== '#') return false;
    this.index += 1;
    this.readWhile((ch) => ch === ' ' || ch === '\t');
    const marker = this.readWhile((ch) => ch === '-' || ch === '=' || ch === '*' || ch === '#');
    this.index = save;
    return marker.length >= 3;
  }

  private parseNewline() {
    if (this.consumeLiteral('\n')) return;
    if (this.isEof()) return;
    this.throwParseError('Expected newline');
  }

  private parseWs() {
    this.readWhile((ch) => ch === ' ' || ch === '\t');
  }

  private readRequiredWs(): string | undefined {
    const start = this.index;
    const ws = this.readWhile((ch) => ch === ' ' || ch === '\t');
    if (!ws) return undefined;
    return this.source.slice(start, this.index);
  }

  private readUntilNewline(): string {
    return this.readWhile((ch) => ch !== '\n');
  }

  private readWhile(predicate: (ch: string) => boolean): string {
    const start = this.index;
    while (!this.isEof() && predicate(this.source[this.index])) {
      this.index += 1;
    }
    return this.source.slice(start, this.index);
  }

  private expectChar(ch: string) {
    if (this.peek() !== ch) {
      this.throwParseError(`Expected '${ch}'`);
    }
    this.index += 1;
  }

  private consumeLiteral(value: string): boolean {
    if (this.source.slice(this.index, this.index + value.length) !== value) return false;
    this.index += value.length;
    return true;
  }

  private peek() {
    return this.source[this.index];
  }

  private readOne(): string {
    if (this.isEof()) this.throwParseError('Unexpected EOF');
    const ch = this.source[this.index];
    this.index += 1;
    return ch;
  }

  private isEof() {
    return this.index >= this.source.length;
  }

  private attempt<T>(fn: () => T): T | undefined {
    const start = this.index;
    try {
      return fn();
    } catch {
      this.index = start;
      return undefined;
    }
  }

  private throwParseError(message: string): never {
    throw new Error(`${message} at index ${this.index}`);
  }
}

export function parseStrictMonogramSource(source: string): ParsedEnvSpecFile {
  const parser = new StrictParser(source);
  return parser.parseFile();
}
